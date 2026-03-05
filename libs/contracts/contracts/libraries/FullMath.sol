// SPDX-License-Identifier: CC-BY-4.0
pragma solidity =0.8.28;

// taken from https://medium.com/coinmonks/math-in-solidity-part-3-percents-and-proportions-4db014e080b1
// license is CC-BY-4.0
library FullMath {
	function fullMul(
		uint256 x,
		uint256 y
	) internal pure returns (uint256 l, uint256 h) {
		uint256 mm = mulmod(x, y, type(uint256).max); // Use `type(uint256).max` instead of `uint256(-1)`
		l = x * y;
		h = mm - l;
		if (mm < l) h -= 1;
	}

	function fullDiv(
		uint256 l,
		uint256 h,
		uint256 d
	) private pure returns (uint256) {
		uint256 pow2 = d & (~d + 1); // Extract the largest power of 2 divisor of d
		d /= pow2; // Divide d by pow2 to make it odd
		l /= pow2; // Divide l by pow2
		l += h * ((~pow2 + 1) / pow2 + 1); // Combine high and low parts

		// Newton-Raphson iteration to approximate the reciprocal of d modulo 2^256
		uint256 r = 1;
		r *= 2 - d * r; // 1st iteration
		r *= 2 - d * r; // 2nd iteration
		r *= 2 - d * r; // 3rd iteration
		r *= 2 - d * r; // 4th iteration
		r *= 2 - d * r; // 5th iteration
		r *= 2 - d * r; // 6th iteration
		r *= 2 - d * r; // 7th iteration
		r *= 2 - d * r; // 8th iteration

		return l * r;
	}

	function mulDiv(
		uint256 x,
		uint256 y,
		uint256 d
	) internal pure returns (uint256) {
		(uint256 l, uint256 h) = fullMul(x, y);

		uint256 mm = mulmod(x, y, d);
		if (mm > l) h -= 1;
		l -= mm;

		if (h == 0) return l / d;

		require(h < d, "FullMath: FULLDIV_OVERFLOW");
		return fullDiv(l, h, d);
	}
}
