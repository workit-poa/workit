// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library CampaignLib {
	function tokenId(address addr) internal pure returns (uint256) {
		return uint256(keccak256(abi.encodePacked(addr)));
	}
}
