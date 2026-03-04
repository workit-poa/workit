// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;
import {AMMLibrary} from "./libraries/AMMLibrary.sol";
import {LiquidityMathLibrary} from "./libraries/LiquidityMathLibrary.sol";
import {Pair} from "./Pair.sol";
import {IViews} from "./interfaces/IViews.sol";

contract Views is IViews {
	address public immutable router;
	address public immutable pairsBeacon;

	constructor(address _router, address _pairsBeacon) {
		router = _router;
		pairsBeacon = _pairsBeacon;
	}

	function feePercent(
		Pair pair,
		address token,
		uint256 amount
	) external view returns (uint256) {
		address token0 = pair.token0();
		address token1 = pair.token1();

		require(token0 == token || token1 == token, "Invalid pair token");

		(uint256 reserve0, uint256 reserve1, ) = pair.getReserves();

		return
			pair.calculateFeePercent(
				amount,
				token == token0 ? reserve0 : reserve1
			);
	}

	function getQuote(
		uint256 amountIn,
		address[] memory path
	) external view returns (uint256 amountOut) {
		for (uint256 i = 0; i < path.length - 1; i++) {
			(uint256 reserveIn, uint256 reserveOut, ) = AMMLibrary.getReserves(
				router,
				pairsBeacon,
				path[i],
				path[i + 1]
			);

			amountIn = amountOut = quote(amountIn, reserveIn, reserveOut);
		}
	}

	function getLiquidityValue(
		address tokenA,
		address tokenB,
		uint256 liquidityAmount
	) external view returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		return
			LiquidityMathLibrary.getLiquidityValue(
				router,
				pairsBeacon,
				tokenA,
				tokenB,
				liquidityAmount
			);
	}

	// **** AMM LIBRARY FUNCTIONS ****
	function quote(
		uint amountA,
		uint reserveA,
		uint reserveB
	) public pure virtual returns (uint amountB) {
		return AMMLibrary.quote(amountA, reserveA, reserveB);
	}

	function getAmountOut(
		uint amountIn,
		uint reserveIn,
		uint reserveOut,
		address pair
	) public view virtual returns (uint[2] memory) {
		return AMMLibrary.getAmountOut(amountIn, reserveIn, reserveOut, pair);
	}

	function getAmountIn(
		uint amountOut,
		uint reserveIn,
		uint reserveOut,
		address pair
	) public view virtual returns (uint[2] memory) {
		return AMMLibrary.getAmountIn(amountOut, reserveIn, reserveOut, pair);
	}

	function getAmountsOut(
		uint amountIn,
		address[] memory path
	) public view virtual returns (uint[2][] memory) {
		return AMMLibrary.getAmountsOut(router, pairsBeacon, amountIn, path);
	}

	function getAmountsIn(
		uint amountOut,
		address[] memory path
	) public view virtual returns (uint[2][] memory) {
		return AMMLibrary.getAmountsIn(router, pairsBeacon, amountOut, path);
	}
}
