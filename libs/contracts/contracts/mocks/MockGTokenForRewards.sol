// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IGToken} from "../tokens/GToken/IGToken.sol";

contract MockGTokenForRewards {
	struct Position {
		bool exists;
		uint256 amount;
		IGToken.Attributes attributes;
	}

	mapping(address => mapping(uint256 => Position)) private _positions;
	uint256 private _totalStakeWeight;

	function setTotalStakeWeight(uint256 value) external {
		_totalStakeWeight = value;
	}

	function totalStakeWeight() external view returns (uint256) {
		return _totalStakeWeight;
	}

	function setPosition(
		address user,
		uint256 nonce,
		uint256 amount,
		IGToken.Attributes calldata attributes
	) external {
		_positions[user][nonce] = Position({
			exists: true,
			amount: amount,
			attributes: attributes
		});
	}

	function getBalanceAt(
		address user,
		uint256 nonce
	) external view returns (IGToken.Balance memory balance) {
		Position storage position = _positions[user][nonce];
		require(position.exists, "MockGToken: position not found");

		balance = IGToken.Balance({
			nonce: nonce,
			amount: position.amount,
			votePower: 0,
			attributes: position.attributes
		});
	}

	function update(
		address user,
		uint256 nonce,
		IGToken.Attributes calldata attr
	) external returns (uint256) {
		Position storage position = _positions[user][nonce];
		require(position.exists, "MockGToken: position not found");
		position.attributes = attr;
		return nonce;
	}

	function getPositionAttributes(
		address user,
		uint256 nonce
	) external view returns (IGToken.Attributes memory) {
		Position storage position = _positions[user][nonce];
		require(position.exists, "MockGToken: position not found");
		return position.attributes;
	}
}
