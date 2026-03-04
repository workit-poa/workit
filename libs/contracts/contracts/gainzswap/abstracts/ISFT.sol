// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title ISFT
 * @dev Interface for the SFTUpgradeable contract, defining essential functions and structures.
 */
interface ISFT is IERC1155 {
	// ================================
	// ========== Events ==============
	// ================================

	/// @notice Emitted when attributes are updated for a token nonce.
	event TokenAttributesUpdated(uint256 indexed nonce, bytes newAttributes);

	/**
	 * @dev Emitted when multiple SFTs are merged into a new one.
	 * @param operator The address that initiated the merge.
	 * @param from The address whose tokens were merged.
	 * @param to The recipient of the new merged SFT.
	 * @param mergedIds The token IDs that were merged.
	 * @param tokenId The ID (nonce) of the SFT that tokens were merged into.
	 * @param totalAmount The total amount combined in the merged SFT.
	 */
	event TokensMerged(
		address indexed operator,
		address indexed from,
		address indexed to,
		uint256[] mergedIds,
		uint256 tokenId,
		uint256 totalAmount
	);

	// Event: emitted when splitting a token into multiple parts
	event TokensSplit(
		address indexed operator,
		address indexed from,
		uint256 indexed originalId,
		address[] recipients,
		uint256[] values,
		uint256 totalSplit
	);

	// ================================
	// ========== Errors ==============
	// ================================

	/// @dev Thrown when attempting to transfer a partial amount of an SFT, which is not allowed.
	error MustTransferAllSFTAmount(uint256 amount);

	/// @dev Thrown when a merge attempt between two SFTs is unauthorized or invalid.
	error UnAuthorizedSFTMerge(
		bytes firstAttr,
		bytes secondAttr,
		string reason
	);

	/// @dev Thrown when an unauthorized user attempts to perform an update action on an SFT.
	error UnAuthorizedSFTTransfer(
		uint256 nonce,
		address from,
		address to,
		address caller,
		string reason
	);

	/**
	 * @dev Struct representing the balance and attributes of an SFT.
	 */
	struct SftBalance {
		uint256 nonce;
		uint256 amount;
		bytes attributes;
	}

	/**
	 * @dev Returns the number of decimals used to get its user representation.
	 * @return The number of decimals.
	 */
	function decimals() external view returns (uint8);

	/**
	 * @dev Returns the name of the token.
	 * @return The token name.
	 */

	function name() external view returns (string memory);

	/**
	 * @dev Returns the symbol of the token.
	 * @return The token symbol.
	 */
	function symbol() external view returns (string memory);

	/**
	 * @dev Returns the list of nonces owned by an address.
	 * @param owner The address of the token owner.
	 * @return Array of nonces.
	 */
	function getNonces(address owner) external view returns (uint256[] memory);

	function getRawTokenAttributes(
		uint256 tokenId
	) external view returns (bytes memory);

	/**
	 * @notice Splits an existing Semi-Fungible Token (SFT) into multiple new sub-tokens
	 *         and transfers each resulting part to a list of recipients.
	 *
	 * @dev
	 * Performs a proportional split of the caller’s token balance for a given SFT ID.
	 * Each resulting sub-token inherits derived attributes from the original token
	 * using `_intoParts()`. The function mints these sub-SFTs directly to recipients,
	 * burns the proportional amount from the sender, and updates or removes the
	 * residual attributes accordingly.
	 *
	 * Key guarantees:
	 *  - Only the token owner or an approved operator can perform a split.
	 *  - The total split value cannot exceed the sender’s full balance.
	 *  - Each new sub-SFT inherits metadata that remains invariant under the split.
	 *  - Any remaining balance retains consistent and proportional attributes.
	 *
	 * @param from The address of the token owner initiating the split.
	 * @param id The unique identifier (nonce) of the original SFT being split.
	 * @param recipients The list of recipient addresses receiving the split SFTs.
	 * @param values The list of token amounts corresponding to each recipient.
	 *
	 * @custom:events
	 * - Emits `TransferSingle` (per ERC-1155) for each minted sub-SFT.
	 * - Emits `TokensSplit` summarizing the entire split operation.
	 *
	 * @custom:reverts
	 * - `ERC1155MissingApprovalForAll` if the caller lacks transfer permission.
	 * - `ERC1155InvalidArrayLength` if `recipients.length != values.length`.
	 * - `ERC1155InsufficientBalance` if the total split exceeds available balance.
	 * - `"InvalidSplitAmount"` if any split portion is zero.
	 * - `"EmptySplitArray"` if no recipients are provided.
	 *
	 * @custom:security
	 * - Protected by `nonReentrant` to prevent reentrancy via mint/transfer hooks.
	 *
	 * @custom:example
	 * ```solidity
	 * // Splitting a 100-unit token into two 40/60 sub-tokens:
	 * splitTransferFrom(
	 *     msg.sender,
	 *     1, // original token ID
	 *     [address(learnerA), address(learnerB)],
	 *     [40, 60]
	 * );
	 * ```
	 */
	function splitTransferFrom(
		address from,
		uint256 id,
		address[] calldata recipients,
		uint256[] calldata values
	) external returns (uint256 finalNonce, uint256[] memory splitIds);

	/**
	 * @notice Merges multiple Semi-Fungible Tokens (SFTs) of the same type
	 *         into a single new SFT and transfers it to a specified recipient.
	 *
	 * @dev
	 * Combines several existing SFT instances owned by `from` into one unified
	 * token. The resulting SFT inherits composite attribute data derived
	 * through `_mergeAttr()`. This function supports flexible merge logic,
	 * allowing token attributes to encode cumulative rewards, access tiers,
	 * or progressive learner credentials.
	 *
	 * The function ensures:
	 *  - Only the token owner or an approved operator can initiate the merge.
	 *  - All source tokens must have a non-zero balance.
	 *  - Attributes are validated for merge compatibility using `_ensureCanMerge()`.
	 *  - Each original token is fully burned before minting the merged SFT.
	 *
	 * @param from The current owner of the SFTs being merged.
	 * @param to The address that will receive the newly merged SFT.
	 * @param ids The list of SFT IDs (nonces) to merge.
	 *
	 * @return nonce The unique identifier of the first SFT that others will be merged into.
	 *
	 * @custom:events
	 * - Emits `TokensMerged` summarizing the merge operation with all merged IDs.
	 *
	 * @custom:reverts
	 * - `ERC1155MissingApprovalForAll` if the caller lacks merge permission.
	 * - `"EmptyMergeArray"` if no token IDs are provided.
	 * - `"InvalidRecipient"` if the `to` address is zero.
	 * - `"ZeroBalanceToken"` if any source SFT has zero balance.
	 * - `UnAuthorizedSFTMerge` if merge compatibility fails in `_ensureCanMerge()`.
	 *
	 * @custom:security
	 * - Protected by `nonReentrant` to prevent reentrancy via burn/mint hooks.
	 *
	 * @custom:example
	 * ```solidity
	 * // Merging two progress-based content SFTs into a single learner credential:
	 * mergeTransferFrom(
	 *     msg.sender,
	 *     msg.sender,
	 *     [courseSFT_A, courseSFT_B]
	 * );
	 * ```
	 */
	function mergeTransferFrom(
		address from,
		address to,
		uint256[] calldata ids
	) external returns (uint256 nonce);
}
