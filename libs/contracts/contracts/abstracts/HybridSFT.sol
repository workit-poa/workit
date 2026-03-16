// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {IHederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";
import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

import {ISFT} from "./ISFT.sol";

abstract contract HybridSFT is AccessControl, ISFT {
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
	bytes32 public constant TRANSFER_ROLE = keccak256("TRANSFER_ROLE");

	address internal constant HTS_PRECOMPILE = address(0x167);
	IHederaTokenService internal constant hts = IHederaTokenService(HTS_PRECOMPILE);

	uint256 private _nonceCounter;
	mapping(uint256 => bytes) public getRawTokenAttributes;
	mapping(address => EnumerableSet.UintSet) private _addressToNonces;
	mapping(address => bool) private _updateOperators;
	string public name;
	string public symbol;
	address public positionNftToken;
	uint256 public positionNftSupply;
	mapping(uint256 => uint256) public positionValueOf;
	mapping(uint256 => address) public getPositionOwner;
	mapping(address => mapping(address => bool)) public override isApprovedForAll;

	error PositionNftAlreadyCreated();
	error PositionNftNotCreated();
	error EmptySplitArray();
	error SplitArrayTooLarge();
	error InvalidSplitAmount();
	error InvalidRecipient();
	error EmptyMergeArray();
	error ZeroBalanceToken();
	error InvalidMetadata();

	constructor(
		string memory name_,
		string memory symbol_,
		address admin
	) {
		require(admin != address(0), "SFT: admin is zero");
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		name = name_;
		symbol = symbol_;
	}

	function createPositionNft(
		uint256 maxSupply,
		string calldata tokenName,
		string calldata tokenSymbol,
		string calldata memo
	)
		external
		payable
		onlyRole(DEFAULT_ADMIN_ROLE)
		returns (address tokenAddress)
	{
		if (maxSupply == 0) revert InvalidMetadata();

		if (positionNftToken != address(0)) {
			revert PositionNftAlreadyCreated();
		}

		IHederaTokenService.KeyValue memory contractKey = IHederaTokenService
			.KeyValue({
				inheritAccountKey: false,
				contractId: address(this),
				ed25519: "",
				ECDSA_secp256k1: "",
				delegatableContractId: address(0)
			});

		IHederaTokenService.HederaToken memory token;
		token.name = tokenName;
		token.symbol = tokenSymbol;
		token.treasury = address(this);
		token.memo = memo;
		token.tokenSupplyType = true;
		token.maxSupply = _toInt64(maxSupply);
		token.freezeDefault = false;
		token.tokenKeys = new IHederaTokenService.TokenKey[](2);
		token.tokenKeys[0] = IHederaTokenService.TokenKey(0x1, contractKey); // admin
		token.tokenKeys[1] = IHederaTokenService.TokenKey(0x10, contractKey); // supply
		token.expiry = IHederaTokenService.Expiry(
			0,
			address(this),
			_toInt64(90 days)
		);

		(int64 responseCode, address createdToken) = hts
			.createNonFungibleToken{value: msg.value}(token);
		_requireSuccess(responseCode);

		positionNftToken = createdToken;

		emit PositionNftCreated(
			createdToken,
			maxSupply,
			tokenName,
			tokenSymbol,
			memo,
			block.timestamp
		);
		return createdToken;
	}

	function associatePositionNft(
		address account
	) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (account == address(0)) revert InvalidRecipient();

		address tokenAddress = _positionNftToken();
		int64 responseCode = hts.associateToken(account, tokenAddress);
		_requireSuccess(responseCode);

		emit PositionNftAssociated(account, tokenAddress, block.timestamp);
	}

	function transferPosition(address from, address to, uint256 serial) external {
		_checkAuthorized(from, _msgSender());

		uint256 amount = _transferPosition(from, to, serial);
		emit TransferSingle(_msgSender(), from, to, serial, amount);
	}

	function splitTransferFrom(
		address from,
		uint256 id,
		address[] calldata recipients,
		uint256[] calldata values
	) external returns (uint256 finalNonce, uint256[] memory splitIds) {
		address operator = _msgSender();
		_validateSplitInputs(from, operator, recipients, values);

				if (getPositionOwner[id] != from) {
			revert ERC1155InsufficientBalance(from, 0, 0, id);
		}

		uint256 fullBalance = positionValueOf[id];
		if (fullBalance == 0) {
			revert ERC1155InsufficientBalance(from, 0, 0, id);
		}

		bytes memory originalAttr = getRawTokenAttributes[id];
		uint256 totalSplit;
		(totalSplit, splitIds) = _processTokenSplits(
			from,
			id,
			recipients,
			values,
			fullBalance,
			originalAttr
		);

		finalNonce = _applySplitResidual(
			from,
			id,
			fullBalance,
			totalSplit,
			originalAttr
		);

		emit TokensSplit(operator, from, id, recipients, values, totalSplit);
	}

	function mergeTransferFrom(
		address from,
		address to,
		uint256[] calldata ids
	) external returns (uint256 nonce) {
		address operator = _msgSender();
		if (ids.length == 0) revert EmptyMergeArray();
		if (to == address(0)) revert InvalidRecipient();

		_checkAuthorized(from, operator);

				bytes memory mergedAttributes;
		uint256 totalAmount;

		for (uint256 i = ids.length; i > 0; ) {
			nonce = ids[i - 1];
			if (getPositionOwner[nonce] != from) revert ZeroBalanceToken();

			uint256 value = positionValueOf[nonce];
			if (value == 0) revert ZeroBalanceToken();

			bytes memory attr = getRawTokenAttributes[nonce];
			_ensureCanTransfer(nonce, from, to, attr);

			if (totalAmount == 0) {
				mergedAttributes = attr;
			} else {
				_ensureCanMerge(mergedAttributes, attr);
				mergedAttributes = _mergeAttr(
					mergedAttributes,
					totalAmount,
					attr,
					value
				);
			}

			totalAmount += value;
			_burnPosition(nonce);

			unchecked {
				--i;
			}
		}

		nonce = _mintPosition(to, totalAmount, mergedAttributes);
		emit TokensMerged(operator, from, to, ids, nonce, totalAmount);
	}

	function approveOperator(
		address owner,
		address operator,
		bool approved
	) public {
		if (owner == address(0)) revert ERC1155InvalidApprover(owner);
		if (operator == address(0)) revert ERC1155InvalidOperator(operator);
		if (owner != _msgSender() && !hasRole(DEFAULT_ADMIN_ROLE, _msgSender())) {
			revert ERC1155InvalidApprover(_msgSender());
		}

		isApprovedForAll[owner][operator] = approved;
		emit ApprovalForAll(owner, operator, approved);
		emit OperatorApproved(owner, operator, approved, _msgSender());
	}

	function setApprovalForAll(address operator, bool approved) public {
		approveOperator(_msgSender(), operator, approved);
	}

	function safeTransferFrom(
		address from,
		address to,
		uint256 id,
		uint256 value,
		bytes memory data
	) public {
		_checkAuthorized(from, _msgSender());

		uint256 amount = _transferPosition(from, to, id);
		if (value != amount) {
			revert MustTransferAllSFTAmount(amount);
		}

		emit TransferSingle(_msgSender(), from, to, id, amount);
		_doSafeTransferAcceptanceCheck(_msgSender(), from, to, id, value, data);
	}

	function safeBatchTransferFrom(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values,
		bytes memory data
	) public {
		if (ids.length != values.length) {
			revert ERC1155InvalidArrayLength(ids.length, values.length);
		}

		_checkAuthorized(from, _msgSender());

		uint256 len = ids.length;
		for (uint256 i; i < len; ) {
			uint256 amount = _transferPosition(from, to, ids[i]);
			if (values[i] != amount) {
				revert MustTransferAllSFTAmount(amount);
			}

			unchecked {
				++i;
			}
		}

		emit TransferBatch(_msgSender(), from, to, ids, values);
		_doSafeBatchTransferAcceptanceCheck(
			_msgSender(),
			from,
			to,
			ids,
			values,
			data
		);
	}

	function balanceOf(
		address account,
		uint256 id
	) public view returns (uint256) {
		if (getPositionOwner[id] != account) {
			return 0;
		}

		return positionValueOf[id];
	}

	function balanceOfBatch(
		address[] memory accounts,
		uint256[] memory ids
	) public view returns (uint256[] memory balances) {
		if (accounts.length != ids.length) {
			revert ERC1155InvalidArrayLength(ids.length, accounts.length);
		}

		balances = new uint256[](accounts.length);
		for (uint256 i; i < accounts.length; ++i) {
			balances[i] = balanceOf(accounts[i], ids[i]);
		}
	}

	function decimals() public pure virtual returns (uint8) {
		return 18;
	}

	function getNonces(address owner) public view returns (uint256[] memory) {
		return _addressToNonces[owner].values();
	}

	function _sftBalance(
		address user
	) internal view returns (SftBalance[] memory balances) {
		uint256[] memory nonces = getNonces(user);
		balances = new SftBalance[](nonces.length);

		for (uint256 i; i < nonces.length; ++i) {
			uint256 nonce = nonces[i];
			balances[i] = SftBalance({
				nonce: nonce,
				amount: positionValueOf[nonce],
				attributes: getRawTokenAttributes[nonce]
			});
		}
	}

	function _mintPosition(
		address to,
		uint256 value,
		bytes memory attributes
	) internal returns (uint256 nonce) {
		if (to == address(0)) revert InvalidRecipient();
		if (value == 0 || attributes.length == 0) revert InvalidMetadata();

				address tokenAddress = _positionNftToken();

		bytes[] memory metadata = new bytes[](1);
		metadata[0] = _positionMintMetadata(attributes, value);

		(int64 responseCode, int64 newTotalSupply, int64[] memory serialNumbers) = hts
			.mintToken(tokenAddress, 0, metadata);
		_requireSuccess(responseCode);
		if (serialNumbers.length != 1) revert InvalidMetadata();

		responseCode = hts.transferNFT(tokenAddress, address(this), to, serialNumbers[0]);
		_requireSuccess(responseCode);

		nonce = _toUint256(serialNumbers[0]);
		if (nonce > _nonceCounter) {
			_nonceCounter = nonce;
		}

		positionNftSupply = _toUint256(newTotalSupply);
		_setRawTokenAttributes(nonce, attributes);
		positionValueOf[nonce] = value;
		getPositionOwner[nonce] = to;
		_addressToNonces[to].add(nonce);

		_updateHook(nonce, address(0), to, value, attributes);
		emit PositionMinted(_msgSender(), to, nonce, value, block.timestamp);
	}

	function _burnPosition(uint256 nonce) internal {
		address owner = getPositionOwner[nonce];
		uint256 value = positionValueOf[nonce];
		bytes memory attributes = getRawTokenAttributes[nonce];
		if (owner == address(0) || value == 0) {
			revert ZeroBalanceToken();
		}

		address tokenAddress = _positionNftToken();
		int64 serial = _toInt64(nonce);

		if (owner != address(this)) {
			int64 transferCode = hts.transferNFT(
				tokenAddress,
				owner,
				address(this),
				serial
			);
			_requireSuccess(transferCode);
		}

		int64[] memory serials = new int64[](1);
		serials[0] = serial;

		(int64 responseCode, int64 newTotalSupply) = hts.burnToken(
			tokenAddress,
			0,
			serials
		);
		_requireSuccess(responseCode);

		positionNftSupply = _toUint256(newTotalSupply);
		_addressToNonces[owner].remove(nonce);
		delete getRawTokenAttributes[nonce];
		delete positionValueOf[nonce];
		delete getPositionOwner[nonce];

		_updateHook(nonce, owner, address(0), value, attributes);
		emit PositionBurned(_msgSender(), owner, nonce, value, block.timestamp);
	}

	function _updateTokenAttributes(
		address user,
		uint256 nonce,
		bytes memory attr
	) internal {
		if (getPositionOwner[nonce] != user) {
			revert("SFT: No balance found at nonce");
		}
		_setRawTokenAttributes(nonce, attr);
	}

	function _transferPosition(
		address from,
		address to,
		uint256 nonce
	) private returns (uint256 value) {
		if (to == address(0)) revert ERC1155InvalidReceiver(to);

				if (getPositionOwner[nonce] != from) {
			revert ERC1155InsufficientBalance(from, 0, positionValueOf[nonce], nonce);
		}

		bytes memory attr = getRawTokenAttributes[nonce];
		_ensureCanTransfer(nonce, from, to, attr);

		int64 responseCode = hts.transferNFT(
			_positionNftToken(),
			from,
			to,
			_toInt64(nonce)
		);
		_requireSuccess(responseCode);

		_addressToNonces[from].remove(nonce);
		_addressToNonces[to].add(nonce);
		getPositionOwner[nonce] = to;

		value = positionValueOf[nonce];
		_updateHook(nonce, from, to, value, attr);
		emit PositionTransferred(_msgSender(), from, to, nonce, value, block.timestamp);
	}

	function _positionMintMetadata(
		bytes memory attributes,
		uint256 value
	) internal view virtual returns (bytes memory) {
		return
			abi.encodePacked(
				keccak256(
					abi.encodePacked(
						address(this),
						block.chainid,
						attributes,
						value,
						_nonceCounter
					)
				)
			);
	}

	function _validateSplitInputs(
		address from,
		address operator,
		address[] calldata recipients,
		uint256[] calldata values
	) internal view {
		_checkAuthorized(from, operator);

		uint256 len = recipients.length;
		if (len != values.length) {
			revert ERC1155InvalidArrayLength(len, values.length);
		}
		if (len == 0) revert EmptySplitArray();
		if (len > 50) revert SplitArrayTooLarge();
	}

	function _processTokenSplits(
		address from,
		uint256 id,
		address[] calldata recipients,
		uint256[] calldata values,
		uint256 fullBalance,
		bytes memory originalAttr
	) private returns (uint256 totalSplit, uint256[] memory splitIds) {
		uint256 len = recipients.length;
		splitIds = new uint256[](len);

		for (uint256 i; i < len; ) {
			address recipient = recipients[i];
			if (recipient == address(0)) revert InvalidRecipient();

			uint256 value = values[i];
			if (value == 0) revert InvalidSplitAmount();

			totalSplit += value;
			if (totalSplit > fullBalance) {
				revert ERC1155InsufficientBalance(
					from,
					fullBalance,
					totalSplit,
					id
				);
			}

			_ensureCanTransfer(id, from, recipient, originalAttr);

			bytes memory splitAttr = _intoParts(value, fullBalance, originalAttr);
			splitIds[i] = _mintPosition(recipient, value, splitAttr);

			unchecked {
				++i;
			}
		}
	}

	function _applySplitResidual(
		address from,
		uint256 id,
		uint256 fullBalance,
		uint256 totalSplit,
		bytes memory originalAttr
	) private returns (uint256 finalNonce) {
		uint256 remaining = fullBalance - totalSplit;
		if (remaining > 0) {
			bytes memory residualAttr = _intoParts(
				remaining,
				fullBalance,
				originalAttr
			);
			_setRawTokenAttributes(id, residualAttr);
			positionValueOf[id] = remaining;

			bytes memory splitAttr = _intoParts(
				totalSplit,
				fullBalance,
				originalAttr
			);
			_updateHook(id, from, address(0), totalSplit, splitAttr);
			return id;
		}

		_burnPosition(id);
		return 0;
	}

	function _setRawTokenAttributes(uint256 nonce, bytes memory attr) private {
		require(attr.length > 0, "SFT: empty attributes not allowed");
		getRawTokenAttributes[nonce] = attr;
		emit TokenAttributesUpdated(nonce, attr);
	}

	function _checkAuthorized(address from, address operator) internal view {
		if (
			from != operator &&
			!hasRole(TRANSFER_ROLE, operator) &&
			!isApprovedForAll[from][operator]
		) {
			revert ERC1155MissingApprovalForAll(operator, from);
		}
	}

	function _positionNftToken() internal view returns (address tokenAddress) {
		tokenAddress = positionNftToken;
		if (tokenAddress == address(0)) {
			revert PositionNftNotCreated();
		}
	}

	function _requireSuccess(int64 responseCode) internal pure {
		if (responseCode != int64(HederaResponseCodes.SUCCESS)) {
			revert HederaCallFailed(responseCode);
		}
	}

	function _toInt64(uint256 amount) internal pure returns (int64) {
		return SafeCast.toInt64(SafeCast.toInt256(amount));
	}

	function _toUint256(int64 amount) internal pure returns (uint256) {
		return SafeCast.toUint256(int256(amount));
	}

	function _doSafeTransferAcceptanceCheck(
		address operator,
		address from,
		address to,
		uint256 id,
		uint256 value,
		bytes memory data
	) private {
		if (to.code.length == 0) return;

		try
			IERC1155Receiver(to).onERC1155Received(
				operator,
				from,
				id,
				value,
				data
			)
		returns (bytes4 response) {
			if (response != IERC1155Receiver.onERC1155Received.selector) {
				revert ERC1155InvalidReceiver(to);
			}
		} catch (bytes memory reason) {
			if (reason.length == 0) {
				revert ERC1155InvalidReceiver(to);
			}
			assembly {
				revert(add(32, reason), mload(reason))
			}
		}
	}

	function _doSafeBatchTransferAcceptanceCheck(
		address operator,
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values,
		bytes memory data
	) private {
		if (to.code.length == 0) return;

		try
			IERC1155Receiver(to).onERC1155BatchReceived(
				operator,
				from,
				ids,
				values,
				data
			)
		returns (bytes4 response) {
			if (response != IERC1155Receiver.onERC1155BatchReceived.selector) {
				revert ERC1155InvalidReceiver(to);
			}
		} catch (bytes memory reason) {
			if (reason.length == 0) {
				revert ERC1155InvalidReceiver(to);
			}
			assembly {
				revert(add(32, reason), mload(reason))
			}
		}
	}

	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		virtual
		override(AccessControl, IERC165)
		returns (bool)
	{
		return
			interfaceId == type(IERC1155).interfaceId ||
			interfaceId == type(ISFT).interfaceId ||
			super.supportsInterface(interfaceId);
	}

	function _intoParts(
		uint256 value,
		uint256 fullValue,
		bytes memory attributes
	) internal virtual returns (bytes memory);

	function _mergeAttr(
		bytes memory firstAttr,
		uint256 firstValue,
		bytes memory secondAttr,
		uint256 secondValue
	) internal virtual returns (bytes memory);

	function _ensureCanTransfer(
		uint256 nonce,
		address from,
		address to,
		bytes memory attributes
	) internal view virtual;

	function _ensureCanMerge(
		bytes memory firstAttr,
		bytes memory secondAttr
	) internal view virtual;

	function _updateHook(
		uint256 nonce,
		address from,
		address to,
		uint256 value,
		bytes memory attributes
	) internal virtual;
}
