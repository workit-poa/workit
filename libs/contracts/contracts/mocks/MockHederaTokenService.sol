// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IHederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";

/// @dev Lightweight HTS precompile mock for local Hardhat tests.
contract MockHederaTokenService {
	int64 private constant SUCCESS = 22;
	int64 private constant FAIL_INVALID = 23;

	uint160 private _tokenNonce;
	mapping(address => bool) private _tokenCreated;
	mapping(address => int64) private _nextSerial;
	mapping(address => int64) private _supply;
	mapping(address => mapping(int64 => address)) private _ownerOf;
	mapping(address => mapping(address => bool)) private _associations;

	function createNonFungibleToken(
		IHederaTokenService.HederaToken memory token
	) external payable returns (int64 responseCode, address tokenAddress) {
		unchecked {
			_tokenNonce += 1;
		}
		tokenAddress = address(uint160(_tokenNonce + 0x1000));

		_tokenCreated[tokenAddress] = true;
		_nextSerial[tokenAddress] = 1;
		_associations[tokenAddress][token.treasury] = true;

		return (SUCCESS, tokenAddress);
	}

	function mintToken(
		address token,
		int64 amount,
		bytes[] memory metadata
	)
		external
		returns (
			int64 responseCode,
			int64 newTotalSupply,
			int64[] memory serialNumbers
		)
	{
		if (!_tokenCreated[token] || amount != 0) {
			return (FAIL_INVALID, _supply[token], new int64[](0));
		}

		uint256 len = metadata.length;
		serialNumbers = new int64[](len);

		int64 next = _nextSerial[token];
		for (uint256 i = 0; i < len; i++) {
			int64 serial = next;
			next += 1;
			serialNumbers[i] = serial;
			_ownerOf[token][serial] = msg.sender;
		}
		_nextSerial[token] = next;

		_supply[token] += int64(int256(len));
		newTotalSupply = _supply[token];
		return (SUCCESS, newTotalSupply, serialNumbers);
	}

	function transferNFT(
		address token,
		address sender,
		address recipient,
		int64 serialNumber
	) external returns (int64 responseCode) {
		if (!_tokenCreated[token] || recipient == address(0)) {
			return FAIL_INVALID;
		}
		if (_ownerOf[token][serialNumber] != sender) {
			return FAIL_INVALID;
		}

		_ownerOf[token][serialNumber] = recipient;
		return SUCCESS;
	}

	function associateToken(
		address account,
		address token
	) external returns (int64 responseCode) {
		if (!_tokenCreated[token] || account == address(0)) {
			return FAIL_INVALID;
		}

		_associations[token][account] = true;
		return SUCCESS;
	}

	function burnToken(
		address token,
		int64 amount,
		int64[] memory serialNumbers
	) external returns (int64 responseCode, int64 newTotalSupply) {
		if (!_tokenCreated[token] || amount != 0) {
			return (FAIL_INVALID, _supply[token]);
		}

		uint256 len = serialNumbers.length;
		for (uint256 i = 0; i < len; i++) {
			if (_ownerOf[token][serialNumbers[i]] != msg.sender) {
				return (FAIL_INVALID, _supply[token]);
			}
			delete _ownerOf[token][serialNumbers[i]];
		}

		_supply[token] -= int64(int256(len));
		return (SUCCESS, _supply[token]);
	}

	function ownerOf(
		address token,
		int64 serialNumber
	) external view returns (address owner) {
		return _ownerOf[token][serialNumber];
	}

	function isAssociated(
		address token,
		address account
	) external view returns (bool) {
		return _associations[token][account];
	}

	function totalSupply(address token) external view returns (int64) {
		return _supply[token];
	}
}
