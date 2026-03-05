// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title WorkInfo
 * @dev A library providing constants for Work token supply and allocations.
 */
library WorkInfo {
	/// @dev Hedera finite-supply tokens are int64-based; 8 decimals keeps 21M supply within bounds.
	uint256 public constant DECIMALS = 8;

	/// @dev Represents 1 token unit in the smallest denomination.
	uint256 public constant ONE = 10 ** DECIMALS;

	/// @dev The maximum supply of Work: 21 million tokens.
	uint256 public constant MAX_SUPPLY = 21_000_000 * ONE;

	/// @dev Allocation for ecosystem distribution.
	uint256 public constant ECOSYSTEM_DISTRIBUTION_FUNDS =
		(13_650_000 * ONE) + 224_857;

	/// @dev Allocation for public sale / initial distribution.
	uint256 public constant ICO_FUNDS =
		MAX_SUPPLY - ECOSYSTEM_DISTRIBUTION_FUNDS;
}
