// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

interface IPair is IERC20 {
	event Mint(address indexed sender, uint256 amount0, uint256 amount1);
	event Burn(
		address indexed sender,
		uint256 amount0,
		uint256 amount1,
		address indexed to
	);
	event Swap(
		address indexed sender,
		uint256 amount0In,
		uint256 amount1In,
		uint256 amount0Out,
		uint256 amount1Out,
		address indexed to
	);
	event Sync(uint112 reserve0, uint112 reserve1);
	event FeeUpdated(uint256 minFee, uint256 maxFee);

	function setFee(uint256 newMinFee, uint256 newMaxFee) external;

	function resetFee() external;

	function calculateFeePercent(
		uint256 amount,
		uint256 reserve
	) external view returns (uint256);

	function feePercents() external view returns (uint256, uint256);

	function router() external view returns (address);

	function token0() external view returns (address);

	function token1() external view returns (address);

	function getReserves()
		external
		view
		returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);

	function price0CumulativeLast() external view returns (uint256);

	function price1CumulativeLast() external view returns (uint256);

	function mint(address to) external returns (uint256 liquidity);

	function burn(
		address to
	) external returns (uint256 amount0, uint256 amount1);

	function swap(uint amount0Out, uint amount1Out, address to) external;

	function initialize(address, address) external;
}
