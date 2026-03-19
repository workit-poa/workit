// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import {ICampaign} from "../listing/ICampaign.sol";
import {CampaignLib} from "../listing/CampaignLib.sol";

interface ICampaignInitializable {
	function initialize(
		address launchpad_,
		address gToken_,
		ICampaign.Listing calldata listing_,
		address initialOwner
	) external;
}

abstract contract CampaignFactory {
	using EnumerableSet for EnumerableSet.AddressSet;

	error CampaignAlreadyExists(address campaign);
	error ZeroAddress();

	EnumerableSet.AddressSet private _campaigns;
	mapping(uint256 => address) public campaignById;
	mapping(address => mapping(address => address)) public campaignByTokens;

	/*//////////////////////////////////////////////////////////////
                         CREATION LOGIC
    //////////////////////////////////////////////////////////////*/

	function _createCampaign(
		address creator,
		address campaignBeacon_,
		address gToken_,
		ICampaign.Listing memory listing_
	) internal returns (address campaign, uint256 campaignId) {
		if (creator == address(0)) revert ZeroAddress();
		if (campaignBeacon_ == address(0)) revert ZeroAddress();
		bytes32 salt = keccak256(
			abi.encodePacked(
				creator,
				address(this),
				gToken_,
				listing_.campaignToken,
				listing_.fundingToken,
				listing_.lockEpochs,
				listing_.goal,
				listing_.deadline
			)
		);
		campaign = address(new BeaconProxy{salt: salt}(
			campaignBeacon_,
			abi.encodeCall(
				ICampaignInitializable.initialize,
				(
					address(this),
					gToken_,
					listing_,
					address(this)
				)
			)
		));

		// Deterministic ID derived from deployed campaign address
		campaignId = CampaignLib.tokenId(campaign);

		if (campaignById[campaignId] != address(0)) {
			revert CampaignAlreadyExists(campaignById[campaignId]);
		}

		// Register campaign
		_campaigns.add(campaign);
		campaignById[campaignId] = campaign;

		campaignByTokens[listing_.fundingToken][
			listing_.campaignToken
		] = campaign;
		campaignByTokens[listing_.campaignToken][
			listing_.fundingToken
		] = campaign; // reverse
	}

	/*//////////////////////////////////////////////////////////////
                          VIEW HELPERS
    //////////////////////////////////////////////////////////////*/

	function campaigns() external view returns (address[] memory) {
		return _campaigns.values();
	}

	function totalCampaigns() external view returns (uint256) {
		return _campaigns.length();
	}

	function isCampaign(address campaign) public view returns (bool) {
		return _campaigns.contains(campaign);
	}

	function _campaignsLength() internal view returns (uint256) {
		return _campaigns.length();
	}
}
