// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

interface ISwapFactory {
	error IdenticalAddress();
	error ZeroAddress();
	error PairExists();

	event PairCreated(
		address indexed token0,
		address indexed token1,
		address pair,
		uint256
	);

	function feeTo() external view returns (address);

	function oldPairs() external view returns (address[] memory);

	function oldPairFor(
		address tokenA,
		address tokenB
	) external view returns (address);
}
