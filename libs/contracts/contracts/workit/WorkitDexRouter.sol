// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IWorkitDexRouter} from "./interfaces/IWorkitDexRouter.sol";
import {IUniswapV2Factory} from "../gainzswap/uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../gainzswap/uniswap-v2/interfaces/IUniswapV2Pair.sol";
import {UniswapV2Library} from "../gainzswap/uniswap-v2/libraries/UniswapV2Library.sol";

contract WorkitDexRouter is IWorkitDexRouter {
	using SafeERC20 for IERC20;

	address public immutable override factory;

	error ZeroAddress();
	error Expired(uint256 deadline, uint256 currentTimestamp);
	error PairNotFound(address tokenA, address tokenB);
	error InsufficientAAmount(uint256 amountA, uint256 amountAMin);
	error InsufficientBAmount(uint256 amountB, uint256 amountBMin);

	constructor(address factory_) {
		if (factory_ == address(0)) revert ZeroAddress();
		factory = factory_;
	}

	function addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	)
		external
		override
		returns (uint256 amountA, uint256 amountB, uint256 liquidity)
	{
		if (deadline < block.timestamp) {
			revert Expired(deadline, block.timestamp);
		}

		address pair = IUniswapV2Factory(factory).getPair(tokenA, tokenB);
		if (pair == address(0)) revert PairNotFound(tokenA, tokenB);

		(amountA, amountB) = _quoteLiquidity(
			tokenA,
			tokenB,
			pair,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin
		);

		IERC20(tokenA).safeTransferFrom(msg.sender, pair, amountA);
		IERC20(tokenB).safeTransferFrom(msg.sender, pair, amountB);

		liquidity = IUniswapV2Pair(pair).mint(to);
	}

	function _quoteLiquidity(
		address tokenA,
		address tokenB,
		address pair,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin
	) internal view returns (uint256 amountA, uint256 amountB) {
		(uint112 reserve0, uint112 reserve1, ) = IUniswapV2Pair(pair).getReserves();
		(address token0, ) = UniswapV2Library.sortTokens(tokenA, tokenB);
		(uint256 reserveA, uint256 reserveB) = tokenA == token0
			? (reserve0, reserve1)
			: (reserve1, reserve0);

		if (reserveA == 0 && reserveB == 0) {
			amountA = amountADesired;
			amountB = amountBDesired;
			return (amountA, amountB);
		}

		uint256 amountBOptimal = UniswapV2Library.quote(
			amountADesired,
			reserveA,
			reserveB
		);
		if (amountBOptimal <= amountBDesired) {
			if (amountBOptimal < amountBMin) {
				revert InsufficientBAmount(amountBOptimal, amountBMin);
			}
			return (amountADesired, amountBOptimal);
		}

		uint256 amountAOptimal = UniswapV2Library.quote(
			amountBDesired,
			reserveB,
			reserveA
		);
		if (amountAOptimal < amountAMin) {
			revert InsufficientAAmount(amountAOptimal, amountAMin);
		}
		return (amountAOptimal, amountBDesired);
	}
}
