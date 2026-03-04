// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract WorkitToken is ERC20, AccessControl {
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	address public treasury;

	event TreasuryUpdated(address indexed previousTreasury, address indexed treasury);
	event WorkitMinted(address indexed to, uint256 amount, address indexed operator);

	error ZeroAddress();

	constructor(address admin, address treasury_) ERC20("WorkIt", "WORKIT") {
		if (admin == address(0) || treasury_ == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(MINTER_ROLE, admin);

		_setTreasury(treasury_);
	}

	function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
		if (to == address(0)) revert ZeroAddress();

		_mint(to, amount);
		emit WorkitMinted(to, amount, msg.sender);
	}

	function setTreasury(address treasury_) external onlyRole(DEFAULT_ADMIN_ROLE) {
		_setTreasury(treasury_);
	}

	function _setTreasury(address treasury_) private {
		if (treasury_ == address(0)) revert ZeroAddress();

		address previousTreasury = treasury;
		treasury = treasury_;

		emit TreasuryUpdated(previousTreasury, treasury_);
	}
}
