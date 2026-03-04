// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import {IUniswapV2Factory} from "./interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "./interfaces/IUniswapV2Pair.sol";
import {FixedPoint} from "./libraries/FixedPoint.sol";

import {UniswapV2Library} from "./libraries/UniswapV2Library.sol";
import {UniswapV2OracleLibrary} from "./libraries/UniswapV2OracleLibrary.sol";

/// @title Sliding Window Oracle (Uniswap V2 style)
/// @notice Provides moving average prices over a configurable time window
/// @dev Singleton oracle; deploy once per parameter set
contract SlidingWindowOracle {
	using FixedPoint for *;

	/* -------------------------------------------------------------------------- */
	/*                                   STRUCTS                                  */
	/* -------------------------------------------------------------------------- */

	struct Observation {
		uint256 timestamp;
		uint256 price0Cumulative;
		uint256 price1Cumulative;
	}

	/* -------------------------------------------------------------------------- */
	/*                                   STORAGE                                  */
	/* -------------------------------------------------------------------------- */

	address public immutable factory;

	/// @notice Total window size (e.g. 24 hours)
	uint256 public immutable windowSize;

	/// @notice Number of observations stored per window
	uint8 public immutable granularity;

	/// @notice Size of each observation period
	uint256 public immutable periodSize;

	/// @notice Pair → observations
	mapping(address => Observation[]) public pairObservations;

	/* -------------------------------------------------------------------------- */
	/*                                CONSTRUCTOR                                 */
	/* -------------------------------------------------------------------------- */

	constructor(address factory_, uint256 windowSize_, uint8 granularity_) {
		require(granularity_ > 1, "SlidingWindowOracle: GRANULARITY");

		uint256 _periodSize = windowSize_ / granularity_;
		require(
			_periodSize * granularity_ == windowSize_,
			"SlidingWindowOracle: WINDOW_NOT_EVENLY_DIVISIBLE"
		);

		factory = factory_;
		windowSize = windowSize_;
		granularity = granularity_;
		periodSize = _periodSize;
	}

	/* -------------------------------------------------------------------------- */
	/*                                OBSERVATIONS                                 */
	/* -------------------------------------------------------------------------- */

	/// @notice Returns index for an observation at a given timestamp
	function observationIndexOf(
		uint256 timestamp
	) public view returns (uint8 index) {
		uint256 epochPeriod = timestamp / periodSize;
		return uint8(epochPeriod % granularity);
	}

	/// @dev Returns the oldest observation in the window
	function _getFirstObservationInWindow(
		address pair
	) internal view returns (Observation storage firstObservation) {
		uint8 observationIndex = observationIndexOf(block.timestamp);
		uint8 firstObservationIndex = (observationIndex + 1) % granularity;

		firstObservation = pairObservations[pair][firstObservationIndex];
	}

	/* -------------------------------------------------------------------------- */
	/*                                   UPDATE                                   */
	/* -------------------------------------------------------------------------- */

	/// @notice Updates oracle state for a token pair
	function update(address tokenA, address tokenB) external {
		address pair = UniswapV2Library.pairFor(factory, tokenA, tokenB);

		// initialize observations if first update
		uint256 obsLength = pairObservations[pair].length;
		for (uint256 i = obsLength; i < granularity; i++) {
			pairObservations[pair].push();
		}

		uint8 observationIndex = observationIndexOf(block.timestamp);
		Observation storage observation = pairObservations[pair][
			observationIndex
		];

		uint256 timeElapsed = block.timestamp - observation.timestamp;

		if (timeElapsed > periodSize) {
			(
				uint256 price0Cumulative,
				uint256 price1Cumulative,

			) = UniswapV2OracleLibrary.currentCumulativePrices(pair);

			observation.timestamp = block.timestamp;
			observation.price0Cumulative = price0Cumulative;
			observation.price1Cumulative = price1Cumulative;
		}
	}

	/* -------------------------------------------------------------------------- */
	/*                              PRICE COMPUTATION                              */
	/* -------------------------------------------------------------------------- */

	function _computeAmountOut(
		uint256 priceCumulativeStart,
		uint256 priceCumulativeEnd,
		uint256 timeElapsed,
		uint256 amountIn
	) internal pure returns (uint256 amountOut) {
		FixedPoint.uq112x112 memory priceAverage = FixedPoint.uq112x112(
			uint224((priceCumulativeEnd - priceCumulativeStart) / timeElapsed)
		);

		amountOut = priceAverage.mul(amountIn).decode144();
	}

	/* -------------------------------------------------------------------------- */
	/*                                   CONSULT                                  */
	/* -------------------------------------------------------------------------- */

	/// @notice Returns time-weighted average price
	function consult(
		address tokenIn,
		uint256 amountIn,
		address tokenOut
	) external view returns (uint256 amountOut) {
		address pair = UniswapV2Library.pairFor(factory, tokenIn, tokenOut);

		Observation storage firstObservation = _getFirstObservationInWindow(
			pair
		);

		uint256 timeElapsed = block.timestamp - firstObservation.timestamp;

		require(
			timeElapsed <= windowSize,
			"SlidingWindowOracle: MISSING_HISTORICAL_OBSERVATION"
		);

		require(
			timeElapsed >= windowSize - periodSize * 2,
			"SlidingWindowOracle: UNEXPECTED_TIME_ELAPSED"
		);

		(
			uint256 price0Cumulative,
			uint256 price1Cumulative,

		) = UniswapV2OracleLibrary.currentCumulativePrices(pair);

		(address token0, ) = UniswapV2Library.sortTokens(tokenIn, tokenOut);

		if (tokenIn == token0) {
			return
				_computeAmountOut(
					firstObservation.price0Cumulative,
					price0Cumulative,
					timeElapsed,
					amountIn
				);
		} else {
			return
				_computeAmountOut(
					firstObservation.price1Cumulative,
					price1Cumulative,
					timeElapsed,
					amountIn
				);
		}
	}
}
