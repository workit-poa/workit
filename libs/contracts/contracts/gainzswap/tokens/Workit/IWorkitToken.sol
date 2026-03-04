// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Epochs} from "../../libraries/Epochs.sol";

interface IWorkitToken {
	event WorkitInitialized(
		address indexed owner,
		address indexed token,
		uint256 icoFunds,
		uint256 ecosystemFunds
	);

	event StakingRewardsCollectorUpdated(
		address indexed previous,
		address indexed current
	);

	event EmissionGenerated(
		uint256 indexed epoch,
		uint256 amount,
		uint256 timestamp
	);

	event StakingRewardsDispatched(
		address indexed rewards,
		uint256 stakingAmount,
		uint256 timestamp
	);

	event WorkitSent(address indexed to, bytes32 indexed entity, uint256 amount);

	function mintWorkit() external;

	/// @notice Backward-compatible alias for legacy integrations.
	function mintGainz() external;

	function stakersWorkitToEmit() external view returns (uint256 toEmit);

	/// @notice Backward-compatible alias for legacy integrations.
	function stakersGainzToEmit() external view returns (uint256 toEmit);

	function epochs() external view returns (Epochs.Storage memory);

	function workitTokenAddress() external view returns (address token);
}
