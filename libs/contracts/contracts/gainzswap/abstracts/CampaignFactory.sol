// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {ICampaign} from "../staking/ICampaign.sol";
import {CampaignLib} from "../staking/CampaignLib.sol";

abstract contract CampaignFactory is Initializable {
	using EnumerableSet for EnumerableSet.AddressSet;

	error CampaignAlreadyExists(address campaign);
	error ZeroAddress();

	/*//////////////////////////////////////////////////////////////
                          ERC-7201 STORAGE
    //////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:gainzswap.campaignfactory.storage
	struct CampaignFactoryStorage {
		EnumerableSet.AddressSet campaigns;
		address campaignBeacon;
		mapping(uint256 => address) campaignById;
		mapping(address => mapping(address => address)) campaignByTokens;
	}

	bytes32 internal constant CAMPAIGN_FACTORY_STORAGE_SLOT =
		keccak256("gainzswap.campaignfactory.storage") &
			~bytes32(uint256(0xff));

	function _getCampaignFactoryStorage()
		internal
		pure
		returns (CampaignFactoryStorage storage $)
	{
		bytes32 slot = CAMPAIGN_FACTORY_STORAGE_SLOT;
		assembly {
			$.slot := slot
		}
	}

	/*//////////////////////////////////////////////////////////////
                             INITIALIZER
    //////////////////////////////////////////////////////////////*/

	function __CampaignFactory_init(
		address campaignBeacon_
	) internal onlyInitializing {
		require(campaignBeacon_ != address(0), "InvalidBeacon");
		_getCampaignFactoryStorage().campaignBeacon = campaignBeacon_;
	}

	/*//////////////////////////////////////////////////////////////
                         CREATION LOGIC
    //////////////////////////////////////////////////////////////*/

	function _createCampaign(
		address creator,
		address gToken_,
		ICampaign.Listing memory listing_
	) internal returns (address campaign, uint256 campaignId) {
		if (creator == address(0)) revert ZeroAddress();
		bytes memory initData = abi.encodeWithSelector(
			ICampaign.initialize.selector,
			address(this),
			gToken_,
			listing_
		);
		CampaignFactoryStorage storage $ = _getCampaignFactoryStorage();

		// Create campaign first to derive deterministic ID
		bytes32 salt = keccak256(abi.encodePacked(creator, initData));

		campaign = address(
			new BeaconProxy{salt: salt}($.campaignBeacon, initData)
		);

		// Deterministic ID derived from deployed campaign address
		campaignId = CampaignLib.tokenId(campaign);

		if ($.campaignById[campaignId] != address(0)) {
			revert CampaignAlreadyExists($.campaignById[campaignId]);
		}

		// Register campaign
		$.campaigns.add(campaign);
		$.campaignById[campaignId] = campaign;

		$.campaignByTokens[listing_.fundingToken][
			listing_.campaignToken
		] = campaign;
		$.campaignByTokens[listing_.campaignToken][
			listing_.fundingToken
		] = campaign; // reverse
	}

	/*//////////////////////////////////////////////////////////////
                          VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

	function campaignById(uint256 campaignId) public view returns (address) {
		return _getCampaignFactoryStorage().campaignById[campaignId];
	}

	function campaignByTokens(
		address tokenA,
		address tokenB
	) public view returns (address) {
		return _getCampaignFactoryStorage().campaignByTokens[tokenA][tokenB];
	}

	function campaigns() external view returns (address[] memory) {
		return _getCampaignFactoryStorage().campaigns.values();
	}

	function totalCampaigns() external view returns (uint256) {
		return _getCampaignFactoryStorage().campaigns.length();
	}

	function isCampaign(address campaign) public view returns (bool) {
		return _getCampaignFactoryStorage().campaigns.contains(campaign);
	}

	function campaignBeacon() public view returns (address) {
		return _getCampaignFactoryStorage().campaignBeacon;
	}
}
