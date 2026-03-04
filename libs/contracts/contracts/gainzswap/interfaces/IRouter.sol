// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenPayment} from "../libraries/TokenPayments.sol";

interface IRouter {
	event Swap(
		address indexed receiver,
		address indexed tokenIn,
		address indexed tokenOut,
		uint256 amountOut,
		uint256 feePercentOut
	);

	function createPair(
		TokenPayment calldata paymentA,
		TokenPayment calldata paymentB
	) external payable returns (address pairAddress, uint256 liquidity);

	function addLiquidity(
		TokenPayment memory paymentA,
		TokenPayment memory paymentB,
		uint amountAMin,
		uint amountBMin,
		uint deadline
	)
		external
		payable
		returns (uint amountA, uint amountB, uint liquidity, address pair);

	function getWrappedNativeToken() external view returns (address);

	function getPairsBeacon() external view returns (address);
}
