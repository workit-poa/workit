// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

interface IPriceOracle {
	event Update(
		address indexed pair,
		uint256 price0Cumulative,
		uint256 price1Cumulative,
		uint256 blockTimestamp
	);

	function router() external view returns (address);

	function pairsBeacon() external view returns (address);

	function add(address tokenA, address tokenB) external;

	function addPair(address pair) external;

	function pairFor(
		address tokenA,
		address tokenB
	) external view returns (address);

	function update(address pair) external;

	function consult(
		address tokenIn,
		address tokenOut,
		uint256 amountIn
	) external view returns (uint256);

	function updateAndConsult(
		address tokenIn,
		address tokenOut,
		uint256 amountIn
	) external returns (uint256);
}
