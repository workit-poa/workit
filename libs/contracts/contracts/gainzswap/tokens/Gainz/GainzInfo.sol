// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title GainzInfo
 * @dev A library providing constants related to the Academy-DEX token (Gainz), including its
 * decimal precision, maximum supply, and various fund allocations.
 */
library GainzInfo {
	/// @dev The number of decimal places the Gainz token uses (18 decimals).
	uint256 public constant DECIMALS = 18;

	/// @dev Represents 1 unit of Gainz in its smallest denomination, taking into account the DECIMALS constant.
	uint256 public constant ONE = 10 ** DECIMALS;

	/// @dev The maximum supply of the Gainz token, which is 21 million tokens.
	uint256 public constant MAX_SUPPLY = 21_000_000 * ONE;

	/**
	 * @dev The amount of Gainz tokens allocated for ecosystem distribution.
	 * This amount is set to 13.65 million tokens plus an additional fractional amount.
	 */
	uint256 public constant ECOSYSTEM_DISTRIBUTION_FUNDS =
		(13_650_000 * ONE) + 2_248_573_618_499_339;

	/**
	 * @dev The amount of Gainz tokens allocated for the Initial Coin Offering (ICO).
	 * This is calculated as the remaining tokens after subtracting ecosystem distribution
	 * funds and initial liquidity from the maximum supply.
	 */
	uint256 public constant ICO_FUNDS =
		MAX_SUPPLY - ECOSYSTEM_DISTRIBUTION_FUNDS;
}
