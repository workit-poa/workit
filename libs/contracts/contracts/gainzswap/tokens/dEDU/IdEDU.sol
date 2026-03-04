// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title IdEDU
/// @notice Interface for DEDU (Delegated EDU)
interface IdEDU is IERC20 {
	/* -------------------------------------------------------------------------- */
	/*                                   EVENTS                                   */
	/* -------------------------------------------------------------------------- */

	event Deposited(address indexed user, uint256 amount);

	event WithdrawalRequested(
		address indexed user,
		uint256 amount,
		uint256 readyTimestamp
	);

	event WithdrawalCompleted(address indexed user, uint256 amount);

	event YuzuAggregatorUpdated(address indexed aggregator);
	event TargetSupplyUpdated(uint256 newTarget);

	/* -------------------------------------------------------------------------- */
	/*                                   STRUCTS                                  */
	/* -------------------------------------------------------------------------- */

	struct UserWithdrawal {
		uint256 amount;
		uint256 readyTimestamp;
	}

	/* -------------------------------------------------------------------------- */
	/*                          DEPOSIT / WITHDRAW LOGIC                           */
	/* -------------------------------------------------------------------------- */

	/// @notice Deposits native EDU on behalf of `owner` and approves `spender`
	function receiveForSpender(address owner, address spender) external payable;

	/// @notice Deposits native EDU and mints dEDU for `owner`
	function receiveFor(address owner) external payable;

	function delegateWEDU(uint256 amount) external;

	/// @notice Initiates a withdrawal request
	function withdraw(uint256 amount) external;

	/// @notice Completes a matured withdrawal
	function completeWithdrawal() external;

	/// @notice Settles pending withdrawals by sending native EDU
	function settleWithdrawals() external payable;

	/* -------------------------------------------------------------------------- */
	/*                                   VIEWS                                    */
	/* -------------------------------------------------------------------------- */

	/// @notice Address of the Yuzu aggregator
	function stakingRewardsCollector() external view returns (address);

	/// @notice Total pending withdrawals
	function pendingWithdrawals() external view returns (uint256);

	/// @notice Pending withdrawal info for a user
	function userPendingWithdrawals(
		address user
	) external view returns (UserWithdrawal memory);
}
