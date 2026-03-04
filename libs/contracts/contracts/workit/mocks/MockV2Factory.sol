// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockV2Pair} from "./MockV2Pair.sol";

contract MockV2Factory {
	address public feeTo;
	address public feeToSetter;

	mapping(address => mapping(address => address)) public getPair;
	address[] public allPairs;

	event PairCreated(
		address indexed token0,
		address indexed token1,
		address pair,
		uint256 pairsLength
	);

	constructor(address feeToSetter_) {
		feeToSetter = feeToSetter_;
	}

	function allPairsLength() external view returns (uint256) {
		return allPairs.length;
	}

	function createPair(address tokenA, address tokenB) external returns (address pair) {
		require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
		require(tokenA != address(0) && tokenB != address(0), "ZERO_ADDRESS");
		require(getPair[tokenA][tokenB] == address(0), "PAIR_EXISTS");

		pair = address(new MockV2Pair(tokenA, tokenB));
		getPair[tokenA][tokenB] = pair;
		getPair[tokenB][tokenA] = pair;
		allPairs.push(pair);

		emit PairCreated(tokenA, tokenB, pair, allPairs.length);
	}

	function setFeeTo(address feeTo_) external {
		require(msg.sender == feeToSetter, "FORBIDDEN");
		feeTo = feeTo_;
	}

	function setFeeToSetter(address feeToSetter_) external {
		require(msg.sender == feeToSetter, "FORBIDDEN");
		feeToSetter = feeToSetter_;
	}
}
