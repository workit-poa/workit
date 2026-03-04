// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library Number {
	/// @notice Restrict a value to a certain interval (Inspired by the `clamp` method in Rust number types).
	/// @dev Returns `max` if `self` is greater than `max`, and `min` if `self` is less than `min`.
	///      Otherwise, returns `self`.
	/// @param self The value to be clamped.
	/// @param min The minimum value allowed.
	/// @param max The maximum value allowed.
	/// @return clamped The clamped value.
	/// @dev Panics if `min > max`.
	function clamp(
		uint256 self,
		uint64 min,
		uint64 max
	) internal pure returns (uint64 clamped) {
		assert(min <= max);
		if (self < min) {
			clamped = min;
		} else if (self > max) {
			clamped = max;
		} else {
			assembly {
				clamped := self
			}
		}
	}

	/// @notice Takes a specific amount from a value, reducing the original value and returning the taken amount.
	/// @dev If `value` is greater than or equal to `amount`, it subtracts `amount` from `value` and returns `amount`.
	///      If `value` is less than `amount`, it returns all of `value` and sets `value` to 0.
	/// @param value The original value, which will be reduced by the taken amount.
	/// @param amount The amount to be taken from `value`.
	/// @return remaining The remaining value after the amount is taken.
	/// @return taken The actual amount taken.
	function take(
		uint256 value,
		uint256 amount
	) internal pure returns (uint256 remaining, uint256 taken) {
		require(amount <= value, "Invalid take amount");

		taken = amount;
		remaining = value - amount;
	}
}
