// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {FixedPoint} from "./uniswap-v2/libraries/FixedPoint.sol";
import {AMMLibrary} from "./libraries/AMMLibrary.sol";
import {OracleLibrary} from "./libraries/OracleLibrary.sol";

import {IPair} from "./interfaces/IPair.sol";

import {IRouter} from "./interfaces/IRouter.sol";
import {IPriceOracle} from "./interfaces/IPriceOracle.sol";

// fixed window oracle that recomputes the average price for the entire period once every period
// note that the price average is only guaranteed to be over at least 1 period, but may be over a longer period
contract PriceOracle is IPriceOracle {
	using FixedPoint for *;

	uint public constant PERIOD = 24 hours;

	address public immutable router;
	address public immutable pairsBeacon;

	mapping(address => address) public token0;
	mapping(address => address) public token1;

	mapping(address => uint) public price0CumulativeLast;
	mapping(address => uint) public price1CumulativeLast;
	mapping(address => uint32) public blockTimestampLast;
	mapping(address => FixedPoint.uq112x112) public price0Average;
	mapping(address => FixedPoint.uq112x112) public price1Average;

	constructor() {
		router = msg.sender;
		pairsBeacon = IRouter(router).getPairsBeacon();
	}

	function add(address tokenA, address tokenB) external {
		address pair = pairFor(tokenA, tokenB);
		addPair(pair);
	}

	function addPair(address pair) public {
		// Prevent multiple additions
		if (blockTimestampLast[pair] != 0) return;

		IPair _pair = IPair(pair);

		token0[pair] = _pair.token0();
		token1[pair] = _pair.token1();
		price0CumulativeLast[pair] = _pair.price0CumulativeLast(); // fetch the current accumulated price value (1 / 0)
		price1CumulativeLast[pair] = _pair.price1CumulativeLast(); // fetch the current accumulated price value (0 / 1)
		uint112 reserve0;
		uint112 reserve1;
		(reserve0, reserve1, blockTimestampLast[pair]) = _pair.getReserves();
		require(reserve0 != 0 && reserve1 != 0, "PriceOracle: NO_RESERVES"); // ensure that there's liquidity in the pair

		emit Update(
			pair,
			price0CumulativeLast[pair],
			price1CumulativeLast[pair],
			blockTimestampLast[pair]
		);
	}

	function pairFor(
		address tokenA,
		address tokenB
	) public view returns (address) {
		return AMMLibrary.pairFor(router, pairsBeacon, tokenA, tokenB);
	}

	function update(address pair) public {
		(
			uint price0Cumulative,
			uint price1Cumulative,
			uint32 blockTimestamp
		) = OracleLibrary.currentCumulativePrices(pair);
		uint32 timeElapsed = blockTimestamp - blockTimestampLast[pair]; // overflow is desired

		// silently fail if period not elapsed
		if (timeElapsed < PERIOD) return;
		if (
			price0Average[pair].mul(1).decode144() != 0 &&
			price1Average[pair].mul(1).decode144() != 0
		) return;

		// overflow is desired, casting never truncates
		// cumulative price is in (uq112x112 price * seconds) units so we simply wrap it after division by time elapsed
		price0Average[pair] = FixedPoint.uq112x112(
			uint224(
				(price0Cumulative - price0CumulativeLast[pair]) / timeElapsed
			)
		);
		price1Average[pair] = FixedPoint.uq112x112(
			uint224(
				(price1Cumulative - price1CumulativeLast[pair]) / timeElapsed
			)
		);

		price0CumulativeLast[pair] = price0Cumulative;
		price1CumulativeLast[pair] = price1Cumulative;
		blockTimestampLast[pair] = blockTimestamp;

		emit Update(pair, price0Cumulative, price1Cumulative, blockTimestamp);
	}

	// note this will always return 0 before update has been called successfully for the first time.
	function _consult(
		address pair,
		address token,
		uint amountIn
	) internal view returns (uint amountOut) {
		if (token == token0[pair]) {
			amountOut = price0Average[pair].mul(amountIn).decode144();
		} else {
			require(token == token1[pair], "PriceOracle: INVALID_TOKEN");
			amountOut = price1Average[pair].mul(amountIn).decode144();
		}
	}

	function consult(
		address tokenIn,
		address tokenOut,
		uint amountIn
	) external view returns (uint) {
		address pair = AMMLibrary.pairFor(
			router,
			pairsBeacon,
			tokenIn,
			tokenOut
		);

		return _consult(pair, tokenIn, amountIn);
	}

	function updateAndConsult(
		address tokenIn,
		address tokenOut,
		uint amountIn
	) external returns (uint) {
		address pair = AMMLibrary.pairFor(
			router,
			pairsBeacon,
			tokenIn,
			tokenOut
		);
		update(pair);

		return _consult(pair, tokenIn, amountIn);
	}
}
