// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ERC1155HolderUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";

import {TokenPayment, TokenPayments} from "./libraries/TokenPayments.sol";
import {GToken, IGToken, GTokenLib} from "./tokens/GToken/GToken.sol";
import {Router} from "./Router.sol";
import {Governance} from "./Governance.sol";
import {FullMath} from "./uniswap-v2/libraries/FullMath.sol";
import {ICampaign} from "./staking/ICampaign.sol";
import {Launchpad} from "./staking/Launchpad.sol";

import {PriceOracle} from "./PriceOracle.sol";
import {OracleLibrary} from "./libraries/OracleLibrary.sol";
import {Epochs} from "./libraries/Epochs.sol";
import {ILaunchPair} from "./interfaces/ILaunchPair.sol";

import "./libraries/utils.sol";
import "./errors.sol";

// todo refactor the campaign migration processes to move all dedu tokens held by this contract to campaignId 1 when it is beign migrated. ensure the migration process accepts only campaign ids 1 and 2, then user migra

uint256 constant MIN_LIQ_VALUE_FOR_LISTING = 5_000e18;

/**
 * @title LaunchPair
 * @dev This contract facilitates the creation and management of crowdfunding campaigns for launching new tokens. Participants contribute funds to campaigns, and if the campaign is successful, they receive launchPair tokens in return. If the campaign fails, their contributions are refunded.
 */
contract LaunchPair is
	OwnableUpgradeable,
	ERC1155HolderUpgradeable,
	Errors,
	ILaunchPair
{
	using TokenPayments for TokenPayment;
	using TokenPayments for address;
	using EnumerableSet for EnumerableSet.UintSet;
	using EnumerableSet for EnumerableSet.AddressSet;
	using Epochs for Epochs.Storage;
	using GTokenLib for IGToken.Attributes;

	/// @custom:storage-location erc7201:gainz.LaunchPair.storage
	struct MainStorage {
		// Mapping from campaign ID to Campaign struct
		mapping(uint256 => Campaign) campaigns;
		// Mapping from campaign ID to a participant's address to their contribution amount
		mapping(uint256 => mapping(address => uint256)) contributions;
		// Mapping from a user's address to the set of campaign IDs they participated in
		mapping(address => EnumerableSet.UintSet) userCampaigns;
		// Set of all campaign IDs
		EnumerableSet.UintSet activeCampaigns;
		// Total number of campaigns created
		uint256 campaignCount;
		GToken gToken;
		mapping(address => TokenListing) pairListing;
		mapping(uint256 => mapping(address => TokenListing)) participatedListings;
		EnumerableSet.AddressSet allowedPairedTokens;
		mapping(address => address[]) pathToNative;
		address dEDU;
		address gainz;
		address governance;
		address router;
		EnumerableSet.AddressSet pendingTokenListing;
		Epochs.Storage epochs;
		address launchpad;
		mapping(uint256 => address) migratedCampaigns;
	}

	// keccak256(abi.encode(uint256(keccak256("gainz.LaunchPair.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant LAUNCHPAIR_STORAGE_LOCATION =
		0x66c8a6ef269fb788d035dbcef8eb7fb6f4739f9cf4d2b8fcd6329d955e05b300;

	function _getMainStorage() private pure returns (MainStorage storage $) {
		assembly {
			$.slot := LAUNCHPAIR_STORAGE_LOCATION
		}
	}

	// Modifier to ensure the campaign exists
	modifier campaignExists(uint256 _campaignId) {
		require(
			_campaignId == 1 || _campaignId == 2,
			"Working only campaigns 1 and 2"
		);
		require(
			_getMainStorage().migratedCampaigns[_campaignId] != address(0),
			"Campaign not migrated"
		);
		_;
	}

	// Modifier to ensure the campaign has met its funding goal
	modifier hasMetGoal(uint256 _campaignId) {
		MainStorage storage $ = _getMainStorage();

		require(
			$.campaigns[_campaignId].fundsRaised >=
				$.campaigns[_campaignId].goal,
			"Goal not met"
		);
		_;
	}

	// Modifier to ensure the caller is a participant in the specified campaign
	modifier isCampaignParticipant(address user, uint256 _campaignId) {
		MainStorage storage $ = _getMainStorage();

		require(
			$.userCampaigns[user].contains(_campaignId),
			"Not a participant of selected campaign"
		);
		_;
	}

	function initialize(address _gToken) public initializer {
		MainStorage storage $ = _getMainStorage();

		__Ownable_init(msg.sender);
		$.gToken = GToken(_gToken);
	}

	function setLaunchpad(address launchpad) external onlyOwner {
		require(launchpad != address(0), "ZeroLaunchpad");
		_getMainStorage().launchpad = launchpad;
	}

	/**
	 *  We are only expecting campaign ids 1 and 2,
	 * the security gTokens and campaign funds have already been withdrawn,
	 * so we do not handle for those scenarios
	 */
	function migrateCampaign(
		// we won't trust and use the owner var from token listing
		TokenListing calldata tokenListing,
		uint256 pendingContribution
	)
		external
		onlyOwner
		returns (address campaign, ICampaign.Listing memory listing)
	{
		require(pendingContribution > 0, "ZeropendingContribution");

		// sufficient check for status failed or success and deadline
		require(
			tokenListing.campaignId == 1 || tokenListing.campaignId == 2,
			"Campaign won't be migrated"
		);

		MainStorage storage $ = _getMainStorage();
		Campaign storage legacyCampaign = $.campaigns[tokenListing.campaignId];

		require(
			$.migratedCampaigns[tokenListing.campaignId] == address(0),
			"Campaign already migrated"
		);
		require(
			legacyCampaign.creator != address(0),
			"Campaign does not exist"
		);
		require($.launchpad != address(0), "LaunchpadNotSet");

		listing = ICampaign.Listing({
			campaignToken: tokenListing.tradeTokenPayment.token,
			fundingToken: tokenListing.pairedToken,
			lockEpochs: tokenListing.epochsLocked,
			goal: legacyCampaign.goal,
			deadline: legacyCampaign.deadline
		});

		Launchpad($.launchpad).migrateCampaign(
			legacyCampaign.creator,
			listing,
			legacyCampaign.status == CampaignStatus.Failed
				? ICampaign.Status.Failed
				: ICampaign.Status.Success,
			pendingContribution
		);

		campaign = Launchpad($.launchpad).campaignByTokens(
			listing.fundingToken,
			listing.campaignToken
		);
		require(campaign != address(0), "CampaignNotCreated");

		$.migratedCampaigns[tokenListing.campaignId] = campaign;

		// For campaign id 2
		if (legacyCampaign.status == CampaignStatus.Success) {
			uint256 gTokenBal = $.gToken.balanceOf(
				address(this),
				legacyCampaign.gtokenNonce
			);
			$.gToken.safeTransferFrom(
				address(this),
				campaign,
				legacyCampaign.gtokenNonce,
				gTokenBal,
				""
			);
			legacyCampaign.gtokenNonce = 0;
		}

		// For campaign id 1
		if (legacyCampaign.status == CampaignStatus.Failed) {
			$.dEDU.sendFungibleToken(pendingContribution, campaign);
		}

		emit CampaignMigrated(tokenListing.campaignId, campaign);
	}

	function migratedCampaign(
		uint256 legacyCampaignId
	) public view returns (address) {
		return _getMainStorage().migratedCampaigns[legacyCampaignId];
	}

	/**
	 * @dev Allows a participant to withdraw their share of launchPair tokens
	 *      after a campaign successfully meets its goals.
	 * @param _campaignId The unique identifier of the campaign.
	 * Requirements:
	 * - The campaign must exist.
	 * - The campaign must have achieved its funding goal.
	 * - The sender must be a participant in the specified campaign.
	 */
	function withdrawLaunchPairToken(
		uint256 _campaignId
	)
		external
		campaignExists(_campaignId)
		hasMetGoal(_campaignId)
		isCampaignParticipant(msg.sender, _campaignId)
		returns (uint256 gTokenNonce)
	{
		MainStorage storage $ = _getMainStorage();
		Campaign storage campaign = $.campaigns[_campaignId];

		require(
			campaign.status == CampaignStatus.Success,
			"Campaign must be successful to withdraw tokens"
		);

		uint256 contribution = $.contributions[_campaignId][msg.sender];
		require(
			contribution > 0,
			"No contributions from sender in this campaign"
		);
		$.contributions[_campaignId][msg.sender] = 0;
		_removeCampaignFromUserCampaigns(msg.sender, _campaignId);

		uint256 userLiqShare;
		(gTokenNonce, userLiqShare) = ICampaign(migratedCampaign(_campaignId))
			.redeemContribution(contribution, msg.sender);

		emit TokensDistributed(
			_campaignId,
			gTokenNonce,
			msg.sender,
			userLiqShare
		);
	}

	/**
	 * @dev Request a refund after a failed campaign.
	 * @param _campaignId The ID of the campaign to refund.
	 */
	function getRefunded(
		uint256 _campaignId
	)
		external
		campaignExists(_campaignId)
		isCampaignParticipant(msg.sender, _campaignId)
	{
		MainStorage storage $ = _getMainStorage();

		Campaign storage campaign = $.campaigns[_campaignId];
		require(
			block.timestamp > campaign.deadline &&
				campaign.fundsRaised < campaign.goal,
			"Refund not available"
		);

		uint256 contribution = $.contributions[_campaignId][msg.sender];
		require(contribution > 0, "No contributions to refund");

		$.contributions[_campaignId][msg.sender] = 0;

		// Update the status to Failed
		campaign.status = CampaignStatus.Failed;
		$.activeCampaigns.remove(_campaignId);

		ICampaign(migratedCampaign(_campaignId)).refundContribution(
			contribution,
			msg.sender
		);
		emit RefundIssued(_campaignId, msg.sender, contribution);
	}

	/**
	 * @dev Get details of a specific campaign.
	 * @param _campaignId The ID of the campaign to get details of.
	 * @return campaign The Campaign struct containing all details of the campaign.
	 */
	function getCampaignDetails(
		uint256 _campaignId
	) external view returns (Campaign memory) {
		MainStorage storage $ = _getMainStorage();

		return $.campaigns[_campaignId];
	}

	/**
	 * @dev Get all campaign IDs.
	 * @return campaignIds An array of all campaign IDs.
	 */
	function getActiveCampaigns() external view returns (uint256[] memory) {
		MainStorage storage $ = _getMainStorage();

		return $.activeCampaigns.values();
	}

	/**
	 * @dev Get campaign IDs that a user has participated in.
	 * @param user The address of the user.
	 * @return campaignIds An array of campaign IDs that the user has participated in.
	 */
	function getUserCampaigns(
		address user
	) public view returns (uint256[] memory) {
		MainStorage storage $ = _getMainStorage();

		return $.userCampaigns[user].values();
	}

	/**
	 * @dev Remove a campaign from the user's participated campaigns after withdrawal or refund.
	 * @param user The address of the user.
	 * @param campaignId The ID of the campaign to remove.
	 */
	function _removeCampaignFromUserCampaigns(
		address user,
		uint256 campaignId
	) internal {
		MainStorage storage $ = _getMainStorage();

		$.userCampaigns[user].remove(campaignId);
		delete $.participatedListings[campaignId][user];
	}

	function campaigns(
		uint256 campaignId
	) public view returns (Campaign memory) {
		return _getMainStorage().campaigns[campaignId];
	}

	function contributions(
		uint256 campaignId,
		address contributor
	) public view returns (uint256) {
		return _getMainStorage().contributions[campaignId][contributor];
	}

	function pairListing(
		address pairOwner
	) public view returns (TokenListing memory) {
		return _getMainStorage().pairListing[pairOwner];
	}

	function participatedListings(
		uint256 campaignId,
		address participant
	) public view returns (TokenListing memory) {
		return _getMainStorage().participatedListings[campaignId][participant];
	}

	function allowedPairPaths()
		external
		view
		returns (address[][] memory paths)
	{
		MainStorage storage $ = _getMainStorage();
		uint256 length = $.allowedPairedTokens.length();
		paths = new address[][](length);

		for (uint256 i; i < length; ++i) {
			address token = $.allowedPairedTokens.at(i);
			paths[i] = $.pathToNative[token];
		}
	}
}
