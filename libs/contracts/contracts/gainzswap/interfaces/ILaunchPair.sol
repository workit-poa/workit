// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenPayment} from "../libraries/TokenPayments.sol";
import {ICampaign} from "../staking/ICampaign.sol";

interface ILaunchPair {
	enum CampaignStatus {
		Pending,
		Funding,
		Failed,
		Success
	}

	struct Campaign {
		address creator;
		uint256 gtokenNonce;
		uint256 goal;
		uint256 deadline;
		uint256 fundsRaised;
		bool isWithdrawn;
		CampaignStatus status;
	}

	struct TokenListing {
		address owner;
		TokenPayment securityGTokenPayment;
		TokenPayment tradeTokenPayment;
		uint256 campaignId;
		address pairedToken;
		uint256 epochsLocked;
	}

	event CampaignCreated(
		uint256 indexed campaignId,
		address indexed creator,
		uint256 goal,
		uint256 deadline
	);
	event ContributionMade(
		uint256 indexed campaignId,
		address indexed contributor,
		uint256 amount
	);
	event TokensDistributed(
		uint256 indexed campaignId,
		uint256 indexed gTokenNonce,
		address indexed contributor,
		uint256 amount
	);
	event FundsWithdrawn(
		uint256 indexed campaignId,
		address indexed creator,
		uint256 amount
	);
	event RefundIssued(
		uint256 indexed campaignId,
		address indexed contributor,
		uint256 amount
	);
	event CampaignMigrated(
		uint256 indexed legacyCampaignId,
		address indexed campaign
	);

	function initialize(address gToken) external;

	function setLaunchpad(address launchpad) external;

	function migrateCampaign(
		TokenListing calldata tokenListing,
		uint256 pendingContribution
	) external returns (address campaign, ICampaign.Listing memory listing);

	function migratedCampaign(
		uint256 legacyCampaignId
	) external view returns (address);

	function withdrawLaunchPairToken(
		uint256 campaignId
	) external returns (uint256 gTokenNonce);

	function getRefunded(uint256 campaignId) external;

	function getCampaignDetails(
		uint256 campaignId
	) external view returns (Campaign memory);

	function getActiveCampaigns() external view returns (uint256[] memory);

	function getUserCampaigns(
		address user
	) external view returns (uint256[] memory);

	function campaigns(
		uint256 campaignId
	) external view returns (Campaign memory);

	function contributions(
		uint256 campaignId,
		address contributor
	) external view returns (uint256);

	function pairListing(
		address pairOwner
	) external view returns (TokenListing memory);

	function participatedListings(
		uint256 campaignId,
		address participant
	) external view returns (TokenListing memory);
}
