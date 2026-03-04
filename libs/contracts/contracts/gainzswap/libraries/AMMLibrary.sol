// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import {IPair} from "../interfaces/IPair.sol";
import {Pair, BASIS_POINTS} from "../Pair.sol";

import "../errors.sol";

library AMMLibrary {
	// returns sorted token addresses, used to handle return values from pairs sorted in this order
	function sortTokens(
		address tokenA,
		address tokenB
	) internal pure returns (address token0, address token1) {
		require(tokenA != tokenB, "AMMLibrary: IDENTICAL_ADDRESSES");
		(token0, token1) = tokenA < tokenB
			? (tokenA, tokenB)
			: (tokenB, tokenA);
		require(token0 != address(0), "AMMLibrary: ZERO_ADDRESS");
	}

	// fetches and sorts the reserves for a pair
	function getReserves(
		address router,
		address pairsBeacon,
		address tokenA,
		address tokenB
	) internal view returns (uint reserveA, uint reserveB, address pair) {
		pair = pairFor(router, pairsBeacon, tokenA, tokenB);

		(address token0, ) = sortTokens(tokenA, tokenB);
		(uint reserve0, uint reserve1, ) = IPair(pair).getReserves();
		(reserveA, reserveB) = tokenA == token0
			? (reserve0, reserve1)
			: (reserve1, reserve0);
	}

	// given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
	function quote(
		uint amountA,
		uint reserveA,
		uint reserveB
	) internal pure returns (uint amountB) {
		require(amountA > 0, "AMMLibrary: INSUFFICIENT_AMOUNT");
		require(
			reserveA > 0 && reserveB > 0,
			"AMMLibrary: INSUFFICIENT_LIQUIDITY"
		);
		amountB = (amountA * reserveB) / reserveA;
	}

	// given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
	function getAmountOut(
		uint amountIn,
		uint reserveIn,
		uint reserveOut,
		address pair
	) internal view returns (uint[2] memory feeData) {
		require(amountIn > 0, "AMMLibrary: INSUFFICIENT_INPUT_AMOUNT");
		require(
			reserveIn > 0 && reserveOut > 0,
			"AMMLibrary: INSUFFICIENT_LIQUIDITY"
		);

		feeData[1] = Pair(pair).calculateFeePercent(
			quote(amountIn, reserveIn, reserveOut),
			reserveOut
		);

		uint amountInWithFee = amountIn * (BASIS_POINTS - feeData[1]);
		uint numerator = amountInWithFee * reserveOut;
		uint denominator = (reserveIn * BASIS_POINTS) + amountInWithFee;
		feeData[0] = numerator / denominator;
	}

	// given an output amount of an asset and pair reserves, returns a required input amount of the other asset
	function getAmountIn(
		uint amountOut,
		uint reserveIn,
		uint reserveOut,
		address pair
	) internal view returns (uint[2] memory feeData) {
		require(amountOut > 0, "AMMLibrary: INSUFFICIENT_OUTPUT_AMOUNT");
		require(
			reserveIn > 0 && reserveOut > 0,
			"AMMLibrary: INSUFFICIENT_LIQUIDITY"
		);

		feeData[1] = Pair(pair).calculateFeePercent(amountOut, reserveOut);

		uint numerator = reserveIn * amountOut * BASIS_POINTS;
		uint denominator = (reserveOut - amountOut) *
			(BASIS_POINTS - feeData[1]);
		feeData[0] = (numerator / denominator) + 1;
	}

	// performs chained getAmountOut calculations on any number of pairs
	function getAmountsOut(
		address router,
		address pairsBeacon,
		uint amountIn,
		address[] memory path
	) internal view returns (uint[2][] memory amounts) {
		if (path.length < 2) revert Errors.InvalidPath(path);

		amounts = new uint[2][](path.length);
		amounts[0][0] = amountIn;
		for (uint i; i < path.length - 1; i++) {
			(uint reserveIn, uint reserveOut, address pair) = getReserves(
				router,
				pairsBeacon,
				path[i],
				path[i + 1]
			);

			amounts[i + 1] = getAmountOut(
				amounts[i][0],
				reserveIn,
				reserveOut,
				pair
			);
		}
	}

	// performs chained getAmountIn calculations on any number of pairs
	function getAmountsIn(
		address router,
		address pairsBeacon,
		uint amountOut,
		address[] memory path
	) internal view returns (uint[2][] memory amounts) {
		require(path.length >= 2, "AMMLibrary: INVALID_PATH");
		amounts = new uint[2][](path.length);
		amounts[amounts.length - 1][0] = amountOut;
		for (uint i = path.length - 1; i > 0; i--) {
			(uint reserveIn, uint reserveOut, address pair) = getReserves(
				router,
				pairsBeacon,
				path[i - 1],
				path[i]
			);
			amounts[i - 1] = getAmountIn(
				amounts[i][0],
				reserveIn,
				reserveOut,
				pair
			);
		}
	}

	function pairFor(
		address routerAddress,
		address pairsBeacon,
		address tokenA,
		address tokenB
	) internal pure returns (address pair) {
		// Sort tokens to maintain consistent order
		(address token0, address token1) = sortTokens(tokenA, tokenB);

		// Get bytecode hash for BeaconProxy with initialization parameters
		bytes32 bytecodeHash = keccak256(
			abi.encodePacked(
				type(BeaconProxy).creationCode,
				abi.encode(
					pairsBeacon,
					abi.encodeWithSelector(
						Pair.initialize.selector,
						token0,
						token1
					)
				)
			)
		);

		bytes32 salt = keccak256(abi.encodePacked(token0, token1));

		// Compute the pair proxy address using CREATE2
		pair = address(
			uint160(
				uint256(
					keccak256(
						abi.encodePacked(
							hex"ff",
							routerAddress,
							salt,
							bytecodeHash
						)
					)
				)
			)
		);
	}
}
