// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IUniswapV2Factory {
	event PairCreated(
		address indexed token0,
		address indexed token1,
		address pair,
		uint pairsLength
	);

	function feeTo() external view returns (address);

	function feeToSetter() external view returns (address);

	function rentPayer() external view returns (address);

	function pairCreateFee() external view returns (uint256);

	function INIT_CODE_PAIR_HASH() external view returns (bytes32);

	function getPair(
		address tokenA,
		address tokenB
	) external view returns (address pair);

	function allPairs(uint) external view returns (address pair);

	function allPairsLength() external view returns (uint);

	function createPair(
		address tokenA,
		address tokenB
	) external payable returns (address pair);

	function setFeeTo(address) external;

	function setFeeToSetter(address) external;

	function setRentPayer(address) external;

	function setPairCreateFee(uint256) external;

	function setTokenCreateFee(uint256) external;
}
