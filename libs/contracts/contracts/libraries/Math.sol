// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// a library for performing various math operations

library Math {
	function min(uint x, uint y) internal pure returns (uint z) {
		z = x < y ? x : y;
	}

	// babylonian method (https://en.wikipedia.org/wiki/Methods_of_computing_square_roots#Babylonian_method)
	function sqrt(uint y) internal pure returns (uint z) {
		if (y > 3) {
			z = y;
			uint x = y / 2 + 1;
			while (x < z) {
				z = x;
				x = (y / x + x) / 2;
			}
		} else if (y != 0) {
			z = 1;
		}
	}

	error MathLinearInterpolationInvalidValues(
		uint256 minIn,
		uint256 currentIn,
		uint256 maxIn
	);

	/// @dev out = (minOut * (maxIn - currentIn) + maxOut * (currentIn - minIn)) / (maxIn - minIn)
	/// 	 https://en.wikipedia.org/wiki/LinearInterpolation
	function linearInterpolation(
		uint256 minIn,
		uint256 maxIn,
		uint256 currentIn,
		uint256 minOut,
		uint256 maxOut
	) internal pure returns (uint256) {
		if (currentIn < minIn || currentIn > maxIn) {
			revert MathLinearInterpolationInvalidValues(
				minIn,
				currentIn,
				maxIn
			);
		}

		uint256 minOutWeighted = minOut * (maxIn - currentIn);
		uint256 maxOutWeighted = maxOut * (currentIn - minIn);
		uint256 inDiff = maxIn - minIn;

		return (minOutWeighted + maxOutWeighted) / inDiff;
	}
}
