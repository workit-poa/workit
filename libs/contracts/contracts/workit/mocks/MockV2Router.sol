// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MockV2Factory} from "./MockV2Factory.sol";
import {MockV2Pair} from "./MockV2Pair.sol";

contract MockV2Router {
	MockV2Factory public immutable factory;
	address public WHBAR;
	address public dHBAR;

	error SlippageExceeded();

	constructor(MockV2Factory factory_, address whbar_, address dhbar_) {
		factory = factory_;
		WHBAR = whbar_;
		dHBAR = dhbar_;
	}

	function addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256
	)
		external
		returns (uint256 amountA, uint256 amountB, uint256 liquidity)
	{
		if (amountADesired < amountAMin || amountBDesired < amountBMin) {
			revert SlippageExceeded();
		}

		address pair = factory.getPair(tokenA, tokenB);
		if (pair == address(0)) {
			pair = factory.createPair(tokenA, tokenB);
		}

		amountA = amountADesired;
		amountB = amountBDesired;

		IERC20(tokenA).transferFrom(msg.sender, pair, amountA);
		IERC20(tokenB).transferFrom(msg.sender, pair, amountB);

		liquidity = amountA < amountB ? amountA : amountB;
		MockV2Pair(pair).mint(to, liquidity);
	}
}
