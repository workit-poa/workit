// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

interface ISFT is IERC1155, IERC1155Errors {
	event TokenAttributesUpdated(uint256 indexed nonce, bytes newAttributes);
	event TokensMerged(
		address indexed operator,
		address indexed from,
		address indexed to,
		uint256[] mergedIds,
		uint256 tokenId,
		uint256 totalAmount
	);
	event TokensSplit(
		address indexed operator,
		address indexed from,
		uint256 indexed originalId,
		address[] recipients,
		uint256[] values,
		uint256 totalSplit
	);
	event PositionNftCreated(
		address indexed token,
		uint256 maxSupply,
		string name,
		string symbol,
		string memo,
		uint256 timestamp
	);
	event PositionNftAssociated(
		address indexed account,
		address indexed token,
		uint256 timestamp
	);
	event PositionMinted(
		address indexed operator,
		address indexed to,
		uint256 indexed nonce,
		uint256 value,
		uint256 timestamp
	);
	event PositionTransferred(
		address indexed operator,
		address indexed from,
		address indexed to,
		uint256 nonce,
		uint256 value,
		uint256 timestamp
	);
	event PositionBurned(
		address indexed operator,
		address indexed from,
		uint256 indexed nonce,
		uint256 value,
		uint256 timestamp
	);
	event OperatorApproved(
		address indexed owner,
		address indexed operator,
		bool approved,
		address approvedBy
	);

	error MustTransferAllSFTAmount(uint256 amount);
	error UnAuthorizedSFTMerge(
		bytes firstAttr,
		bytes secondAttr,
		string reason
	);
	error UnAuthorizedSFTTransfer(
		uint256 nonce,
		address from,
		address to,
		address caller,
		string reason
	);
	error HederaCallFailed(int64 responseCode);

	struct SftBalance {
		uint256 nonce;
		uint256 amount;
		bytes attributes;
	}

	function decimals() external view returns (uint8);

	function name() external view returns (string memory);

	function symbol() external view returns (string memory);

	function createPositionNft(
		uint256 maxSupply,
		string calldata tokenName,
		string calldata tokenSymbol,
		string calldata memo
	) external payable returns (address tokenAddress);

	function associatePositionNft(address account) external;

	function positionNftToken() external view returns (address);

	function positionNftSupply() external view returns (uint256);

	function positionValueOf(uint256 nonce) external view returns (uint256);

	function getPositionOwner(uint256 nonce) external view returns (address);

	function approveOperator(
		address owner,
		address operator,
		bool approved
	) external;

	function getNonces(address owner) external view returns (uint256[] memory);

	function getRawTokenAttributes(
		uint256 tokenId
	) external view returns (bytes memory);

	function transferPosition(address from, address to, uint256 serial) external;

	function splitTransferFrom(
		address from,
		uint256 id,
		address[] calldata recipients,
		uint256[] calldata values
	) external returns (uint256 finalNonce, uint256[] memory splitIds);

	function mergeTransferFrom(
		address from,
		address to,
		uint256[] calldata ids
	) external returns (uint256 nonce);
}
