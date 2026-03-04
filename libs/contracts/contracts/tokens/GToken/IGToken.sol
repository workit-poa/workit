// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../../libraries/Epochs.sol";

interface IGToken {
	struct LiquidityInfo {
		address token0;
		address token1;
		uint256 liquidity;
		uint256 liqValue;
		address pair;
	}

	/// @dev Attributes struct holds the data related to a participant's stake in the GToken contract.
	struct Attributes {
		uint256 rewardPerShare;
		uint256 epochStaked;
		uint256 epochsLocked;
		uint256 lastClaimEpoch;
		uint256 stakeWeight;
		LiquidityInfo lpDetails;
	}

	struct Balance {
		uint256 nonce;
		uint256 amount;
		uint256 votePower;
		Attributes attributes;
	}

	/// @notice Emitted when a GToken is transferred, minted, or burned
	event GTokenTransfer(
		address indexed from,
		address indexed to,
		uint256 id,
		uint256 stakeWeight,
		uint256 supply
	);

	/// @notice Mint a new GToken
	/// @param to Recipient address
	/// @param rewardPerShare Reward per share
	/// @param epochsLocked Number of epochs locked
	/// @param lpDetails Liquidity info
	/// @return nonce Token ID of minted GToken
	function mintGToken(
		address to,
		uint256 rewardPerShare,
		uint256 epochsLocked,
		LiquidityInfo memory lpDetails
	) external returns (uint256);

	/// @notice Burn an existing GToken held by caller
	/// @param nonce Token ID
	function burn(uint256 nonce) external;

	/// @notice Update attributes of a GToken
	/// @param user Token owner
	/// @param nonce Token ID
	/// @param attr New attributes
	/// @return nonce Token ID updated
	function update(
		address user,
		uint256 nonce,
		Attributes memory attr
	) external returns (uint256);

	/// @notice Get a single GToken balance at a specific nonce
	/// @param user Owner address
	/// @param nonce Token ID
	/// @return Balance struct
	function getBalanceAt(
		address user,
		uint256 nonce
	) external view returns (Balance memory);

	/// @notice Get all GToken balances for a user
	/// @param user Owner address
	/// @return Array of Balance structs
	function getBalance(address user) external view returns (Balance[] memory);

	/// @notice Get the attributes of a GToken by nonce
	/// @param nonce Token ID
	/// @return Attributes struct
	function getAttributes(
		uint256 nonce
	) external view returns (Attributes memory);

	/// @notice Get the epoch storage
	/// @return Epochs.Storage struct
	function epochs() external view returns (Epochs.Storage memory);

	/// @notice Total stake weight across all tokens
	/// @return uint256 total stake weight
	function totalStakeWeight() external view returns (uint256);

	/// @notice Total supply for a specific liquidity pair
	/// @param pair LP pair address
	/// @return uint256 total supply
	function pairSupply(address pair) external view returns (uint256);

	/// @notice Total supply of all GTokens
	/// @return uint256 total supply
	function totalSupply() external view returns (uint256);
}
