// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

import {IUniswapV2Pair} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Factory} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Factory.sol";
import {IERC20} from "../../vendor/saucerswap-periphery/contracts/interfaces/IERC20.sol";

import {Babylonian} from "./Babylonian.sol";
import {FullMath} from "./FullMath.sol";
import {UniswapV2Library} from "./UniswapV2Library.sol";

/// @title UniswapV2LiquidityMathLibrary
/// @notice Math helpers for valuing Uniswap V2 liquidity positions
library UniswapV2LiquidityMathLibrary {
	/*//////////////////////////////////////////////////////////////
	             PROFIT-MAXIMISING ARBITRAGE
	//////////////////////////////////////////////////////////////*/

	/// @notice Computes direction and size of the profit-maximising arbitrage trade
	function computeProfitMaximizingTrade(
		uint256 truePriceTokenA,
		uint256 truePriceTokenB,
		uint256 reserveA,
		uint256 reserveB
	) internal pure returns (bool aToB, uint256 amountIn) {
		aToB =
			FullMath.mulDiv(reserveA, truePriceTokenB, reserveB) <
			truePriceTokenA;

		uint256 invariant = reserveA * reserveB;

		uint256 leftSide = Babylonian.sqrt(
			FullMath.mulDiv(
				invariant * 1000,
				aToB ? truePriceTokenA : truePriceTokenB,
				(aToB ? truePriceTokenB : truePriceTokenA) * 997
			)
		);

		uint256 rightSide = (aToB ? reserveA * 1000 : reserveB * 1000) / 997;

		if (leftSide < rightSide) return (false, 0);

		amountIn = leftSide - rightSide;
	}

	/*//////////////////////////////////////////////////////////////
	                   RESERVES AFTER ARB
	//////////////////////////////////////////////////////////////*/

	function getReservesAfterArbitrage(
		address factory,
		address tokenA,
		address tokenB,
		uint256 truePriceTokenA,
		uint256 truePriceTokenB
	) internal view returns (uint256 reserveA, uint256 reserveB) {
		(reserveA, reserveB) = UniswapV2Library.getReserves(
			factory,
			tokenA,
			tokenB
		);

		require(
			reserveA > 0 && reserveB > 0,
			"UniswapV2LiquidityMathLibrary: ZERO_PAIR_RESERVES"
		);

		(bool aToB, uint256 amountIn) = computeProfitMaximizingTrade(
			truePriceTokenA,
			truePriceTokenB,
			reserveA,
			reserveB
		);

		if (amountIn == 0) {
			return (reserveA, reserveB);
		}

		if (aToB) {
			uint256 amountOut = UniswapV2Library.getAmountOut(
				amountIn,
				reserveA,
				reserveB
			);
			reserveA += amountIn;
			reserveB -= amountOut;
		} else {
			uint256 amountOut = UniswapV2Library.getAmountOut(
				amountIn,
				reserveB,
				reserveA
			);
			reserveB += amountIn;
			reserveA -= amountOut;
		}
	}

	/*//////////////////////////////////////////////////////////////
	                   LIQUIDITY VALUATION
	//////////////////////////////////////////////////////////////*/

	function computeLiquidityValue(
		uint256 reservesA,
		uint256 reservesB,
		uint256 totalSupply,
		uint256 liquidityAmount,
		bool feeOn,
		uint256 kLast
	) internal pure returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		if (feeOn && kLast > 0) {
			uint256 rootK = Babylonian.sqrt(reservesA * reservesB);
			uint256 rootKLast = Babylonian.sqrt(kLast);

			if (rootK > rootKLast) {
				uint256 numerator1 = totalSupply;
				uint256 numerator2 = rootK - rootKLast;
				uint256 denominator = rootK + (rootKLast / 5);

				uint256 feeLiquidity = FullMath.mulDiv(
					numerator1,
					numerator2,
					denominator
				);

				totalSupply += feeLiquidity;
			}
		}

		tokenAAmount = (reservesA * liquidityAmount) / totalSupply;
		tokenBAmount = (reservesB * liquidityAmount) / totalSupply;
	}

	/*//////////////////////////////////////////////////////////////
	                EXTERNAL-STATE HELPERS
	//////////////////////////////////////////////////////////////*/

	function getLiquidityValue(
		address factory,
		address tokenA,
		address tokenB,
		uint256 liquidityAmount
	) internal view returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		(uint256 reservesA, uint256 reservesB) = UniswapV2Library.getReserves(
			factory,
			tokenA,
			tokenB
		);

		IUniswapV2Pair pair = IUniswapV2Pair(
			UniswapV2Library.pairFor(factory, tokenA, tokenB)
		);
		address pairLpToken = pair.lpToken();

		bool feeOn = IUniswapV2Factory(factory).feeTo() != address(0);
		uint256 kLast = feeOn ? pair.kLast() : 0;
		uint256 totalSupply = IERC20(pairLpToken).totalSupply();

		return
			computeLiquidityValue(
				reservesA,
				reservesB,
				totalSupply,
				liquidityAmount,
				feeOn,
				kLast
			);
	}

	function getLiquidityValueAfterArbitrageToPrice(
		address factory,
		address tokenA,
		address tokenB,
		uint256 truePriceTokenA,
		uint256 truePriceTokenB,
		uint256 liquidityAmount
	) internal view returns (uint256 tokenAAmount, uint256 tokenBAmount) {
		bool feeOn = IUniswapV2Factory(factory).feeTo() != address(0);

		IUniswapV2Pair pair = IUniswapV2Pair(
			UniswapV2Library.pairFor(factory, tokenA, tokenB)
		);

		uint256 kLast = feeOn ? pair.kLast() : 0;
		uint256 totalSupply = IERC20(address(pair)).totalSupply();

		require(
			liquidityAmount > 0 && liquidityAmount <= totalSupply,
			"ComputeLiquidityValue: LIQUIDITY_AMOUNT"
		);

		(uint256 reservesA, uint256 reservesB) = getReservesAfterArbitrage(
			factory,
			tokenA,
			tokenB,
			truePriceTokenA,
			truePriceTokenB
		);

		return
			computeLiquidityValue(
				reservesA,
				reservesB,
				totalSupply,
				liquidityAmount,
				feeOn,
				kLast
			);
	}
}
