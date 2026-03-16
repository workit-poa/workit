// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockUniswapV2Factory {
	bytes32 public constant INIT_CODE_PAIR_HASH =
		hex"8a62051beff3ffc67cf93cf2bb14423b76ca1d02dbfe8e2779b6cc7850cfab57";
	mapping(address => mapping(address => address)) public getPair;

	function setPair(address tokenA, address tokenB, address pair) external {
		getPair[tokenA][tokenB] = pair;
		getPair[tokenB][tokenA] = pair;
	}

	function createPair(
		address tokenA,
		address tokenB
	) external payable returns (address pair) {
		require(tokenA != tokenB, "IDENTICAL_ADDRESSES");
		(address token0, address token1) = tokenA < tokenB
			? (tokenA, tokenB)
			: (tokenB, tokenA);
		require(token0 != address(0), "ZERO_ADDRESS");

		address existing = getPair[token0][token1];
		if (existing != address(0)) {
			return existing;
		}

		pair = address(
			uint160(
				uint256(
					keccak256(
						abi.encodePacked(
							hex"ff",
							address(this),
							keccak256(abi.encodePacked(token0, token1)),
							INIT_CODE_PAIR_HASH
						)
					)
				)
			)
		);
		getPair[token0][token1] = pair;
		getPair[token1][token0] = pair;
	}
}
