// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

/// @title IWHBAR
/// @notice Interface for Wrapped HBAR (WHBAR), WETH-style wrapper
interface IWHBAR {
	/* -------------------------------------------------------------------------- */
	/*                                   EVENTS                                   */
	/* -------------------------------------------------------------------------- */

	event Approval(address indexed src, address indexed guy, uint256 wad);
	event Transfer(address indexed src, address indexed dst, uint256 wad);
	event Deposit(address indexed dst, uint256 wad);
	event Withdrawal(address indexed src, uint256 wad);

	/* -------------------------------------------------------------------------- */
	/*                               ERC20 METADATA                                */
	/* -------------------------------------------------------------------------- */

	function name() external view returns (string memory);
	function symbol() external view returns (string memory);
	function decimals() external view returns (uint8);

	/* -------------------------------------------------------------------------- */
	/*                               ERC20 STORAGE                                 */
	/* -------------------------------------------------------------------------- */

	function totalSupply() external view returns (uint256);
	function balanceOf(address owner) external view returns (uint256);
	function allowance(
		address owner,
		address spender
	) external view returns (uint256);

	/* -------------------------------------------------------------------------- */
	/*                               ERC20 ACTIONS                                 */
	/* -------------------------------------------------------------------------- */

	function approve(address spender, uint256 amount) external returns (bool);
	function transfer(address to, uint256 amount) external returns (bool);
	function transferFrom(
		address from,
		address to,
		uint256 amount
	) external returns (bool);

	/* -------------------------------------------------------------------------- */
	/*                              WRAP / UNWRAP                                  */
	/* -------------------------------------------------------------------------- */

	function deposit() external payable;
	function withdraw(uint256 wad) external;
}
