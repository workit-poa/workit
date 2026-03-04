// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @title WorkitGToken
/// @notice ERC1155 receipt token representing WORKIT-weighted liquidity per pool.
/// @dev tokenId is derived from (poolAddress, chainId, campaignId) and each pool is registered once.
contract WorkitGToken is ERC1155, AccessControl {
	bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
	bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

	mapping(address => uint256) public poolToTokenId;
	mapping(uint256 => address) public tokenIdToPool;

	error ZeroAddress();
	error ZeroAmount();
	error PoolNotRegistered(address pool);
	error PoolAlreadyRegistered(address pool);
	error InvalidPoolTokenId(uint256 tokenId);

	event PoolRegistered(
		address indexed pool,
		uint256 indexed tokenId,
		uint256 chainId,
		uint256 campaignId
	);
	event GTokenMinted(
		address indexed user,
		address indexed pool,
		uint256 indexed tokenId,
		uint256 amount
	);
	event GTokenBurned(
		address indexed user,
		address indexed pool,
		uint256 indexed tokenId,
		uint256 amount
	);

	constructor(address admin, string memory uri_) ERC1155(uri_) {
		if (admin == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(POOL_MANAGER_ROLE, admin);
		_grantRole(MINTER_ROLE, admin);
		_grantRole(BURNER_ROLE, admin);
	}

	/// @notice Deterministic token id derived from pool context.
	function deriveTokenId(
		address poolAddress,
		uint256 chainId,
		uint256 campaignId
	) public pure returns (uint256) {
		return uint256(keccak256(abi.encode(poolAddress, chainId, campaignId)));
	}

	/// @notice Registers a pool id mapping once so future mints are cheap.
	function registerPool(
		address pool,
		uint256 chainId,
		uint256 campaignId
	) public onlyRole(POOL_MANAGER_ROLE) returns (uint256 tokenId) {
		tokenId = _registerPool(pool, chainId, campaignId);
	}

	function _registerPool(
		address pool,
		uint256 chainId,
		uint256 campaignId
	) internal returns (uint256 tokenId) {
		if (pool == address(0)) revert ZeroAddress();
		if (poolToTokenId[pool] != 0) revert PoolAlreadyRegistered(pool);

		tokenId = deriveTokenId(pool, chainId, campaignId);
		poolToTokenId[pool] = tokenId;
		tokenIdToPool[tokenId] = pool;

		emit PoolRegistered(pool, tokenId, chainId, campaignId);
	}

	/// @notice Mints GToken equal to WORKIT-side liquidity amount.
	function mintForLiquidity(
		address to,
		address pool,
		uint256 chainId,
		uint256 campaignId,
		uint256 workitAmountDeposited
	) external onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
		if (to == address(0) || pool == address(0)) revert ZeroAddress();
		if (workitAmountDeposited == 0) revert ZeroAmount();

		tokenId = poolToTokenId[pool];
		if (tokenId == 0) tokenId = _registerPool(pool, chainId, campaignId);

		_mint(to, tokenId, workitAmountDeposited, "");
		emit GTokenMinted(to, pool, tokenId, workitAmountDeposited);
	}

	/// @notice Burns stake receipt token on liquidity withdrawal.
	function burn(
		address from,
		uint256 tokenId,
		uint256 amount
	) external onlyRole(BURNER_ROLE) {
		if (from == address(0)) revert ZeroAddress();
		if (amount == 0) revert ZeroAmount();
		address pool = tokenIdToPool[tokenId];
		if (pool == address(0)) revert InvalidPoolTokenId(tokenId);

		_burn(from, tokenId, amount);
		emit GTokenBurned(from, pool, tokenId, amount);
	}

	function supportsInterface(
		bytes4 interfaceId
	) public view virtual override(ERC1155, AccessControl) returns (bool) {
		return super.supportsInterface(interfaceId);
	}
}
