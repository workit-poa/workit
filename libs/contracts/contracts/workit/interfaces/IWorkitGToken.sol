// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWorkitGToken {
	enum SeriesType {
		None,
		Listing,
		Security
	}

	struct SeriesConfig {
		address pool;
		address quoteToken;
		uint256 campaignId;
		SeriesType seriesType;
		bool exists;
	}

	function deriveTokenId(address pool) external view returns (uint256);

	function tokenIdForPool(address pool) external view returns (uint256);

	function poolForToken(uint256 tokenId) external view returns (address);

	function isListingPool(address pool) external view returns (bool);

	function isListingTokenId(uint256 tokenId) external view returns (bool);

	function seriesConfig(
		uint256 tokenId
	) external view returns (SeriesConfig memory);

	function registerListingPool(
		address pool,
		address quoteToken,
		uint256 campaignId
	) external returns (uint256 tokenId);

	function mintListing(
		address to,
		address pool,
		uint256 amount
	) external returns (uint256 tokenId);

	function burn(address from, uint256 tokenId, uint256 amount) external;

	function safeTransferFrom(
		address from,
		address to,
		uint256 id,
		uint256 value,
		bytes calldata data
	) external;

	function balanceOf(
		address account,
		uint256 id
	) external view returns (uint256);
}
