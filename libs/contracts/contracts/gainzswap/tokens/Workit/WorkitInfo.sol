// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title WorkitInfo
/// @notice Supply constants for HTS-native WORKIT.
library WorkitInfo {
	/// @dev HTS fungible token decimals are typically <= 8.
	uint256 public constant DECIMALS = 8;
	uint256 public constant ONE = 10 ** DECIMALS;

	/// @dev Emission maths reused from Gainz are in 18-decimal precision.
	/// Scale those emissions down to WORKIT precision.
	uint256 public constant EMISSION_SCALE = 10 ** (18 - DECIMALS);

	uint256 public constant MAX_SUPPLY = 21_000_000 * ONE;

	/// @dev Preserve Gainz-style split with decimals adjusted to 8.
	uint256 public constant ECOSYSTEM_DISTRIBUTION_FUNDS =
		(13_650_000 * ONE) + 224_857;

	uint256 public constant ICO_FUNDS =
		MAX_SUPPLY - ECOSYSTEM_DISTRIBUTION_FUNDS;
}
