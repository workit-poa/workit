// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockUniswapV2Factory {
	mapping(address => mapping(address => address)) public getPair;

	function setPair(address tokenA, address tokenB, address pair) external {
		getPair[tokenA][tokenB] = pair;
		getPair[tokenB][tokenA] = pair;
	}

	function createPair(
		address tokenA,
		address tokenB
	) external returns (address pair) {
		address existing = getPair[tokenA][tokenB];
		if (existing != address(0)) {
			return existing;
		}

		pair = address(
			uint160(
				uint256(
					keccak256(abi.encodePacked(tokenA, tokenB, block.chainid))
				)
			)
		);
		getPair[tokenA][tokenB] = pair;
		getPair[tokenB][tokenA] = pair;
	}
}
