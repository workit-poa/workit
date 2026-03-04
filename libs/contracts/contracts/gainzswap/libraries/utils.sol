// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

function isERC20(address tokenAddress) returns (bool) {
	if (address(0) == tokenAddress) {
		return false;
	}

	(bool success, bytes memory name) = tokenAddress.call(
		abi.encodeWithSignature("name()")
	);
	require(success, "Unable to check low level call for token address");

	return name.length > 0;
}

function weightedAverageRoundUp(
	uint256 a,
	uint256 wa,
	uint256 b,
	uint256 wb
) pure returns (uint256) {
	uint256 numerator = (a * wa) + (b * wb);
	uint256 denominator = wa + wb;
	// Use mulDiv with rounding up
	return Math.ceilDiv(numerator, denominator);
}
