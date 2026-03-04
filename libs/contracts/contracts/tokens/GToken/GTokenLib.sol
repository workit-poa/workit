// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Math} from "../../libraries/Math.sol";
import {IGToken} from "./IGToken.sol";

/// @title GTokenLib
/// @notice Utility library for GToken staking, voting power, and penalty maths
library GTokenLib {
	/* -------------------------------------------------------------------------- */
	/*                                   CONSTANTS                                */
	/* -------------------------------------------------------------------------- */

	uint256 internal constant MIN_EPOCHS_LOCK = 0;
	uint256 internal constant MAX_EPOCHS_LOCK = 1080;

	uint256 internal constant MIN_LOCK_LOSS = 55e4; // 55%
	uint256 internal constant MAX_LOCK_LOSS = 15e4; // 15%
	uint256 internal constant MAX_PERCENT = 100e4; // 100%

	/* -------------------------------------------------------------------------- */
	/*                               STAKE WEIGHT                                 */
	/* -------------------------------------------------------------------------- */

	function computeStakeWeight(
		IGToken.Attributes memory self,
		uint256 currentEpoch
	) internal pure returns (IGToken.Attributes memory) {
		uint256 locked = self.epochsLocked;
		require(
			locked >= MIN_EPOCHS_LOCK && locked <= MAX_EPOCHS_LOCK,
			"GToken: invalid lock"
		);

		uint256 _supply = supply(self);
		uint256 liquidity = self.lpDetails.liquidity;

		require(
			(liquidity == 0 && _supply == 0) || (liquidity > 0 && _supply > 0),
			"GToken: invalid liquidity"
		);

		self.stakeWeight = _supply * (1 + epochsLeft(self, currentEpoch));
		return self;
	}

	function supply(
		IGToken.Attributes memory self
	) internal pure returns (uint256) {
		return self.lpDetails.liqValue;
	}

	/* -------------------------------------------------------------------------- */
	/*                              EPOCH CALCULATIONS                            */
	/* -------------------------------------------------------------------------- */

	function epochsLeft(
		IGToken.Attributes memory self,
		uint256 currentEpoch
	) internal pure returns (uint256) {
		if (currentEpoch <= self.epochStaked) {
			return self.epochsLocked;
		}

		uint256 elapsed = currentEpoch - self.epochStaked;
		return elapsed >= self.epochsLocked ? 0 : self.epochsLocked - elapsed;
	}

	function epochsUnclaimed(
		IGToken.Attributes memory self
	) internal pure returns (uint256) {
		return self.epochsLocked - self.lastClaimEpoch;
	}

	/* -------------------------------------------------------------------------- */
	/*                               VOTING POWER                                 */
	/* -------------------------------------------------------------------------- */

	/// @dev Quadratic decay model inspired by Sovryn governance
	function votePower(
		IGToken.Attributes memory self,
		uint256 currentEpoch
	) internal pure returns (uint256) {
		uint256 remaining = epochsLeft(self, currentEpoch);

		uint256 x = (MAX_EPOCHS_LOCK - remaining);
		uint256 m = MAX_EPOCHS_LOCK;

		uint256 weight = ((9e6 * (m * m - x * x)) / (m * m)) + 1e6;

		return self.lpDetails.liqValue * weight;
	}

	/* -------------------------------------------------------------------------- */
	/*                             PENALTY / VALUE MATH                           */
	/* -------------------------------------------------------------------------- */

	function valueToKeep(
		IGToken.Attributes memory self,
		uint256 value,
		uint256 currentEpoch
	) internal pure returns (uint256) {
		require(self.epochsLocked > 0, "GToken: no lock");

		uint256 elapsed = currentEpoch > self.epochStaked
			? currentEpoch - self.epochStaked
			: 0;

		uint256 lockLoss = Math.linearInterpolation(
			MIN_EPOCHS_LOCK,
			MAX_EPOCHS_LOCK,
			self.epochsLocked,
			MIN_LOCK_LOSS,
			MAX_LOCK_LOSS
		);

		uint256 loss = elapsed >= self.epochsLocked
			? 0
			: Math.linearInterpolation(
				0,
				self.epochsLocked,
				self.epochsLocked - elapsed,
				0,
				lockLoss
			);

		return (value * (MAX_PERCENT - loss)) / MAX_PERCENT;
	}

	/* -------------------------------------------------------------------------- */
	/*                                 HELPERS                                    */
	/* -------------------------------------------------------------------------- */

	function hasToken(
		IGToken.Attributes memory self,
		address token
	) internal pure returns (bool) {
		return self.lpDetails.token0 == token || self.lpDetails.token1 == token;
	}

	function decode(
		bytes memory data
	) internal pure returns (IGToken.Attributes memory) {
		return abi.decode(data, (IGToken.Attributes));
	}
}
