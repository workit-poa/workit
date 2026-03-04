// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Epochs} from "../libraries/Epochs.sol";

interface IRewards {
	error PairNotFound(address token0, address token1);

	/*//////////////////////////////////////////////////////////////
	                                EVENTS
	//////////////////////////////////////////////////////////////*/

	/// @notice Emitted once during initialization
	event RewardsInitialized(
		address indexed gainz,
		address indexed gtoken,
		address indexed router
	);

	/// @notice Emitted when new rewards are accounted for
	event RewardsUpdated(
		uint256 totalAdded,
		uint256 holdersShare,
		uint256 dEDUShare,
		uint256 rewardPerShare
	);

	/// @notice Emitted when a user successfully claims rewards
	event RewardsClaimed(
		address indexed user,
		address indexed to,
		uint256 indexed epoch,
		uint256 timestamp,
		uint256 amount,
		uint256 rewardPerShare
	);

	/// @notice Emitted when rewards are redirected fully to dEDU
	event RewardsRedirectedToDEDU(uint256 amount);

	/*//////////////////////////////////////////////////////////////
	                              FUNCTIONS
	//////////////////////////////////////////////////////////////*/

	function updateRewardReserve() external;

	function claimRewards(uint256[] calldata nonces, address to) external;

	function claimableFor(
		address user,
		uint256[] calldata nonces
	) external view returns (uint256 claimable);

	function rewardPerShare() external view returns (uint256 rewardPerShare);

	function gainz() external view returns (address);

	function gToken() external view returns (address);
}
