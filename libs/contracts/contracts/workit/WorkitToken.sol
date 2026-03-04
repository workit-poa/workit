// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title WorkitToken
/// @notice Native WorkIt token used for launch liquidity, emissions, and ecosystem treasury allocations.
/// @dev Role-based minting with optional EIP-2612 permit support via OZ ERC20Permit.
contract WorkitToken is ERC20, ERC20Permit, AccessControl {
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
	bytes32 public constant TREASURY_MANAGER_ROLE =
		keccak256("TREASURY_MANAGER_ROLE");

	/// @notice Treasury address that receives ecosystem allocations.
	address public treasury;

	error ZeroAddress();

	event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
	event Minted(address indexed to, uint256 amount, address indexed operator);

	constructor(
		address admin,
		address treasury_,
		uint256 initialTreasuryMint
	) ERC20("WorkIt", "WORKIT") ERC20Permit("WorkIt") {
		if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(MINTER_ROLE, admin);
		_grantRole(TREASURY_MANAGER_ROLE, admin);

		treasury = treasury_;

		if (initialTreasuryMint > 0) {
			_mint(treasury_, initialTreasuryMint);
			emit Minted(treasury_, initialTreasuryMint, msg.sender);
		}
	}

	/// @notice Updates treasury destination.
	function setTreasury(address newTreasury) external onlyRole(TREASURY_MANAGER_ROLE) {
		if (newTreasury == address(0)) revert ZeroAddress();
		address oldTreasury = treasury;
		treasury = newTreasury;
		emit TreasuryUpdated(oldTreasury, newTreasury);
	}

	/// @notice Mints WORKIT to an arbitrary address.
	function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
		if (to == address(0)) revert ZeroAddress();
		_mint(to, amount);
		emit Minted(to, amount, msg.sender);
	}

	/// @notice Mints WORKIT directly to treasury.
	function mintToTreasury(uint256 amount) external onlyRole(MINTER_ROLE) {
		_mint(treasury, amount);
		emit Minted(treasury, amount, msg.sender);
	}
}
