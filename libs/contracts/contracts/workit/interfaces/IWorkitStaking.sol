// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWorkitStaking {
	function enableListingPool(address pool) external;

	function setPoolEmissionWeight(address pool, uint256 newWeight) external;

	function updateRewardReserve() external;
}
