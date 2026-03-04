// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IWorkitGToken} from "./interfaces/IWorkitGToken.sol";

contract WorkitGToken is ERC1155, ERC1155Supply, AccessControl, IWorkitGToken {
	bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
	bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

	mapping(address => uint256) private _poolToTokenId;
	mapping(uint256 => SeriesConfig) private _seriesByToken;

	event PoolSeriesRegistered(
		uint256 indexed tokenId,
		address indexed pool,
		SeriesType seriesType,
		address quoteToken,
		uint256 campaignId
	);
	event ListingMinted(
		uint256 indexed tokenId,
		address indexed pool,
		address indexed to,
		uint256 amount
	);

	error ZeroAddress();
	error InvalidSeriesType();
	error PoolSeriesMismatch(
		uint256 tokenId,
		SeriesType expected,
		SeriesType actual
	);
	error QuoteTokenMismatch(address expected, address actual);
	error CampaignIdMismatch(uint256 expected, uint256 actual);
	error TokenIdAlreadyConfigured(uint256 tokenId);
	error PoolNotRegistered(address pool);
	error NotListingSeries(uint256 tokenId);

	constructor(address admin, string memory uri_) ERC1155(uri_) {
		if (admin == address(0)) revert ZeroAddress();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(POOL_MANAGER_ROLE, admin);
		_grantRole(MINTER_ROLE, admin);
		_grantRole(BURNER_ROLE, admin);
	}

	function deriveTokenId(address pool) public view override returns (uint256) {
		if (pool == address(0)) revert ZeroAddress();

		return uint256(keccak256(abi.encodePacked(block.chainid, pool)));
	}

	function tokenIdForPool(address pool) external view override returns (uint256) {
		return _poolToTokenId[pool];
	}

	function poolForToken(uint256 tokenId) external view override returns (address) {
		return _seriesByToken[tokenId].pool;
	}

	function isListingPool(address pool) external view override returns (bool) {
		uint256 tokenId = _poolToTokenId[pool];
		return
			tokenId != 0 &&
			_seriesByToken[tokenId].exists &&
			_seriesByToken[tokenId].seriesType == SeriesType.Listing;
	}

	function isListingTokenId(uint256 tokenId) external view override returns (bool) {
		return
			_seriesByToken[tokenId].exists &&
			_seriesByToken[tokenId].seriesType == SeriesType.Listing;
	}

	function seriesConfig(
		uint256 tokenId
	) external view override returns (SeriesConfig memory) {
		return _seriesByToken[tokenId];
	}

	function registerListingPool(
		address pool,
		address quoteToken,
		uint256 campaignId
	) external override onlyRole(POOL_MANAGER_ROLE) returns (uint256 tokenId) {
		if (quoteToken == address(0)) revert ZeroAddress();

		return
			_registerPool(pool, quoteToken, campaignId, SeriesType.Listing);
	}

	function registerSecurityPool(
		address pool,
		address quoteToken,
		uint256 campaignId
	) external onlyRole(POOL_MANAGER_ROLE) returns (uint256 tokenId) {
		if (quoteToken == address(0)) revert ZeroAddress();

		return
			_registerPool(pool, quoteToken, campaignId, SeriesType.Security);
	}

	function mintListing(
		address to,
		address pool,
		uint256 amount
	) external override onlyRole(MINTER_ROLE) returns (uint256 tokenId) {
		if (to == address(0) || pool == address(0)) revert ZeroAddress();

		tokenId = _poolToTokenId[pool];
		if (tokenId == 0) revert PoolNotRegistered(pool);
		if (_seriesByToken[tokenId].seriesType != SeriesType.Listing) {
			revert NotListingSeries(tokenId);
		}

		_mint(to, tokenId, amount, "");
		emit ListingMinted(tokenId, pool, to, amount);
	}

	function burn(
		address from,
		uint256 tokenId,
		uint256 amount
	) external override onlyRole(BURNER_ROLE) {
		_burn(from, tokenId, amount);
	}

	function safeTransferFrom(
		address from,
		address to,
		uint256 id,
		uint256 value,
		bytes memory data
	) public override(ERC1155, IWorkitGToken) {
		super.safeTransferFrom(from, to, id, value, data);
	}

	function balanceOf(
		address account,
		uint256 id
	) public view override(ERC1155, IWorkitGToken) returns (uint256) {
		return super.balanceOf(account, id);
	}

	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		override(ERC1155, AccessControl)
		returns (bool)
	{
		return super.supportsInterface(interfaceId);
	}

	function _update(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values
	) internal override(ERC1155, ERC1155Supply) {
		super._update(from, to, ids, values);
	}

	function _registerPool(
		address pool,
		address quoteToken,
		uint256 campaignId,
		SeriesType seriesType
	) private returns (uint256 tokenId) {
		if (pool == address(0)) revert ZeroAddress();
		if (seriesType == SeriesType.None) revert InvalidSeriesType();

		tokenId = _poolToTokenId[pool];
		if (tokenId != 0) {
			SeriesConfig storage existingConfig = _seriesByToken[tokenId];
			if (existingConfig.seriesType != seriesType) {
				revert PoolSeriesMismatch(
					tokenId,
					seriesType,
					existingConfig.seriesType
				);
			}
			if (existingConfig.quoteToken != quoteToken) {
				revert QuoteTokenMismatch(existingConfig.quoteToken, quoteToken);
			}
			if (existingConfig.campaignId != campaignId) {
				revert CampaignIdMismatch(existingConfig.campaignId, campaignId);
			}
			return tokenId;
		}

		tokenId = deriveTokenId(pool);
		if (_seriesByToken[tokenId].exists) {
			revert TokenIdAlreadyConfigured(tokenId);
		}

		_poolToTokenId[pool] = tokenId;
		_seriesByToken[tokenId] = SeriesConfig({
			pool: pool,
			quoteToken: quoteToken,
			campaignId: campaignId,
			seriesType: seriesType,
			exists: true
		});

		emit PoolSeriesRegistered(tokenId, pool, seriesType, quoteToken, campaignId);
	}
}
