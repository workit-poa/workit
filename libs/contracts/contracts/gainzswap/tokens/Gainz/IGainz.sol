// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Epochs} from "../../libraries/Epochs.sol";

/**
 * @title IGainz
 * @dev External interface for the Gainz ERC20 token and emission logic.
 */
interface IGainz {
	event GainzInitialized(
		address indexed owner,
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

	event GainzSent(address indexed to, bytes32 indexed entity, uint256 amount);

	/**
	 * @dev Triggers emission calculation and distributes staking rewards.
	 */
	function mintGainz() external;

	/**
	 * @dev View helper returning the amount of Gainz pending for stakers
	 * if emissions were generated at the current timestamp.
	 */
	function stakersGainzToEmit() external view returns (uint256 toEmit);

	function epochs() external view returns (Epochs.Storage memory);
}
