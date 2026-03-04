// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AMMLibrary} from "./AMMLibrary.sol";
import {Pair} from "../Pair.sol";

// library containing some math for dealing with the liquidity shares of a pair, e.g. computing their exact value
// in terms of the underlying tokens
library LiquidityMathLibrary {
	// computes liquidity value given all the parameters of the pair
	function computeLiquidityValue(
		uint256 reservesA,
		uint256 reservesB,
		uint256 totalSupply,
		uint256 liquidityAmount
	) internal pure returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		return (
			(reservesA * liquidityAmount) / totalSupply,
			(reservesB * liquidityAmount) / totalSupply
		);
	}

	// get all current parameters from the pair and compute value of a liquidity amount
	// **note this is subject to manipulation, e.g. sandwich attacks**. prefer passing a manipulation resistant price to
	// #getLiquidityValueAfterArbitrageToPrice
	function getLiquidityValue(
		address router,
		address pairsBeacon,
		address tokenA,
		address tokenB,
		uint256 liquidityAmount
	) internal view returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		(uint256 reservesA, uint256 reservesB, ) = AMMLibrary.getReserves(
			router,
			pairsBeacon,
			tokenA,
			tokenB
		);
		Pair pair = Pair(
			AMMLibrary.pairFor(router, pairsBeacon, tokenA, tokenB)
		);

		uint totalSupply = pair.totalSupply();
		return
			computeLiquidityValue(
				reservesA,
				reservesB,
				totalSupply,
				liquidityAmount
			);
	}
}
