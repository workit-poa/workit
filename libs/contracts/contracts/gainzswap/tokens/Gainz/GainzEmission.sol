// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "prb-math/contracts/PRBMathSD59x18.sol";

/// @notice Emitted when trying to convert a uint256 number that doesn't fit within int256.
error ToInt256CastOverflow(uint256 number);

/// @notice Emitted when trying to convert an int256 number that doesn't fit within uint256.
error ToUint256CastOverflow(int256 number);

/**
 * @notice Safely casts a uint256 to int256.
 * @param x The uint256 number to cast.
 * @return result The int256 representation of the given uint256.
 * @dev Reverts with ToInt256CastOverflow if the input number is larger than int256's max value.
 */
function toInt256(uint256 x) pure returns (int256 result) {
	if (x > uint256(type(int256).max)) {
		revert ToInt256CastOverflow(x);
	}
	result = int256(x);
}

/**
 * @notice Safely casts an int256 to uint256.
 * @param x The int256 number to cast.
 * @return result The uint256 representation of the given int256.
 * @dev Reverts with ToUint256CastOverflow if the input number is negative.
 */
function toUint256(int256 x) pure returns (uint256 result) {
	if (x < 0) {
		revert ToUint256CastOverflow(x);
	}
	result = uint256(x);
}

/**
 * @title GainzEmission
 * @dev A library for calculating the emission of tokens over time based on an epoch model with a decay rate.
 * @dev Uses PRBMathSD59x18 library for fixed-point math operations.
 */
library GainzEmission {
	using PRBMathSD59x18 for int256;

	/// @dev The decay rate per epoch, represented with 18 decimals (0.9998).
	int256 internal constant DECAY_RATE = 9998e14;

	/// @dev Initial emission at epoch 0.
	int256 internal constant E0 = 2729727036845720116116;

	/**
	 * @notice Computes the emission at a specific epoch.
	 * @param epoch The epoch for which to compute the emission.
	 * @return The emission value at the given epoch.
	 */
	function atEpoch(uint256 epoch) internal pure returns (uint256) {
		return toUint256((E0 * epochDecayFactor(epoch)) / 1e18);
	}

	/**
	 * @notice Computes the total emission over a range of epochs.
	 * @param epochStart The starting epoch.
	 * @param epochEnd The ending epoch.
	 * @return The total emission through the epoch range.
	 * @dev The function computes the emission using the formula:
	 * E0 * (0.9998^epochStart − 0.9998^epochEnd) / ln(0.9998)
	 */
	function throughEpochRange(
		uint256 epochStart,
		uint256 epochEnd
	) internal pure returns (uint256) {
		require(
			epochEnd > epochStart,
			"GainzEmission: epochEnd must be greater than epochStart"
		);

		int256 startFactor = epochDecayFactor(epochStart);
		int256 endFactor = epochDecayFactor(epochEnd);

		int256 totalEmission = (E0 * (startFactor - endFactor)) /
			DECAY_RATE.ln();

		// Return the absolute value of totalEmission as uint256
		return toUint256(totalEmission * -1);
	}

	/**
	 * @notice Computes the emission over a time range within a specific epoch.
	 * @param epoch The epoch during which the time range occurs.
	 * @param timeRange The duration of the time range.
	 * @param epochLength The total length of the epoch.
	 * @return The total emission over the specified time range.
	 */
	function throughTimeRange(
		uint256 epoch,
		uint256 timeRange,
		uint256 epochLength
	) internal pure returns (uint256) {
		return (atEpoch(epoch) * timeRange) / epochLength;
	}

	/**
	 * @notice Computes the decay factor for a given epoch.
	 * @param epoch The epoch for which to compute the decay factor.
	 * @return The decay factor for the specified epoch.
	 */
	function epochDecayFactor(uint256 epoch) private pure returns (int256) {
		return PRBMathSD59x18.pow(DECAY_RATE, toInt256(epoch * 1e18)); // Multiplying by 1e18 for precission
	}
}

library Entities {
	uint32 public constant UNITY = 100_00;

	uint32 public constant TEAM = 10_00;
	uint32 public constant STAKING = 70_00;
	uint32 public constant LIQ_INCENTIVE = 15_00;
	uint32 public constant GROWTH = 5_00;

	struct Value {
		uint256 team;
		uint256 growth;
		uint256 staking;
		uint256 liqIncentive;
	}

	/// @notice Allocates total value based on predefined ratios.
	/// @param totalValue The total value to be allocated.
	/// @return Allocated values for each category.
	function fromTotalValue(
		uint256 totalValue
	) internal pure returns (Value memory) {
		// Calculate the total value to be distributed among others (non-staking categories)
		uint256 othersTotal = (totalValue * (UNITY - STAKING)) / UNITY;
		// Calculate proportional allocation for each category
		uint256 team = (othersTotal * TEAM) / UNITY;
		uint256 growth = (othersTotal * GROWTH) / UNITY;
		uint256 liqIncentive = (othersTotal * LIQ_INCENTIVE) / UNITY;

		// Remaining value is allocated to staking
		uint256 staking = totalValue - (team + growth + liqIncentive);

		// Return the structured allocation
		return
			Value({
				team: team,
				growth: growth,
				staking: staking,
				liqIncentive: liqIncentive
			});
	}

	/// @notice Computes the total value from individual allocations.
	/// @param value The `Value` struct containing allocations.
	/// @return The total value.
	function total(Value memory value) internal pure returns (uint256) {
		return value.team + value.growth + value.staking + value.liqIncentive;
	}

	/// @notice Adds another `Value` struct to the current one.
	/// @param self The current `Value` struct.
	/// @param rhs The `Value` struct to add.
	function add(Value storage self, Value memory rhs) internal {
		self.team += rhs.team;
		self.growth += rhs.growth;
		self.staking += rhs.staking;
		self.liqIncentive += rhs.liqIncentive;
	}

	function addReturn(
		Value memory self,
		Value memory rhs
	) internal pure returns (Value memory) {
		self.team += rhs.team;
		self.growth += rhs.growth;
		self.staking += rhs.staking;
		self.liqIncentive += rhs.liqIncentive;

		return self;
	}
}
