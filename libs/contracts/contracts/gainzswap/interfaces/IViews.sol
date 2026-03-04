// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {Pair} from "../Pair.sol";

interface IViews {
	function router() external view returns (address);

	function pairsBeacon() external view returns (address);

	function feePercent(
		Pair pair,
		address token,
		uint256 amount
	) external view returns (uint256);

	function getQuote(
		uint256 amountIn,
		address[] memory path
	) external view returns (uint256 amountOut);

	function getLiquidityValue(
		address tokenA,
		address tokenB,
		uint256 liquidityAmount
	) external view returns (uint256 tokenAAmount, uint256 tokenBAmount);

	function quote(
		uint256 amountA,
		uint256 reserveA,
		uint256 reserveB
	) external pure returns (uint256 amountB);

	function getAmountOut(
		uint256 amountIn,
		uint256 reserveIn,
		uint256 reserveOut,
		address pair
	) external view returns (uint256[2] memory);

	function getAmountIn(
		uint256 amountOut,
		uint256 reserveIn,
		uint256 reserveOut,
		address pair
	) external view returns (uint256[2] memory);

	function getAmountsOut(
		uint256 amountIn,
		address[] memory path
	) external view returns (uint256[2][] memory);

	function getAmountsIn(
		uint256 amountOut,
		address[] memory path
	) external view returns (uint256[2][] memory);
}
