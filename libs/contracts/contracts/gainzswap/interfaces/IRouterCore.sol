// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {IUniswapV2Router} from "./IUniswapV2Router.sol";
import {ISwapFactory} from "./ISwapFactory.sol";

interface IRouterCore is IUniswapV2Router, ISwapFactory {
	function initialize(address wedu, address dedu, address factory) external;

	function initializeV2(address wedu, address dedu, address factory) external;

	function removeLiquidityOld(
		address tokenA,
		address tokenB,
		uint256 liquidity,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	) external returns (uint256 amountA, uint256 amountB);

	function feeToSetter() external view returns (address);

	function setFeeTo(address feeTo) external;

	function setFeeToSetter(address feeToSetter) external;
}
