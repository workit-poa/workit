// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

/// @title A library for handling binary fixed point numbers (UQ112x112)
/// @notice range: [0, 2**112 - 1], resolution: 1 / 2**112
library UQ112x112 {
	uint224 constant Q112 = 2 ** 112;

	/// @notice Encode a uint112 as a UQ112x112
	/// @param y The integer to encode
	/// @return z The encoded fixed point number
	function encode(uint112 y) internal pure returns (uint224 z) {
		z = uint224(y) * Q112; // never overflows in 0.8.x
	}

	/// @notice Divide a UQ112x112 by a uint112, returning a UQ112x112
	/// @param x The UQ112x112 numerator
	/// @param y The uint112 denominator
	/// @return z The result of the division
	function uqdiv(uint224 x, uint112 y) internal pure returns (uint224 z) {
		z = x / uint224(y);
	}
}
