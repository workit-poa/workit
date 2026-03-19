// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ISFT} from "./ISFT.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

abstract contract SFT is
	Initializable,
	ERC1155Upgradeable,
	AccessControlUpgradeable,
	ISFT
{
	using EnumerableSet for EnumerableSet.UintSet;

	// ================================
	// ========== Roles ===============
	// ================================

	/**
	 * @dev Role identifier for the minter role.
	 */
	bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

	/**
	 * @dev Role identifier for the can send role.
	 */
	bytes32 public constant TRANSFER_ROLE = keccak256("TRANSFER_ROLE");

	uint256 public nonceCounter;
	mapping(uint256 => bytes) public override getRawTokenAttributes;
	mapping(address => EnumerableSet.UintSet) private addressToNonces;
	string public override name;
	string public override symbol;

	// ================================
	// ========== Initializer =========
	// ================================

	/**
	 * @dev Initializes the SFT contract with a name, symbol, and admin address.
	 * @param name_ The name of the token.
	 * @param symbol_ The symbol of the token.
	 * @param admin The admin account to receive DEFAULT_ADMIN_ROLE.
	 */
	function __SFT_init(
		string memory name_,
		string memory symbol_,
		address admin
	) public onlyInitializing {
		__ERC1155_init("");
		__AccessControl_init();

		name = name_;
		symbol = symbol_;
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
	}

	// ================================
	// ========== Public Actions ======
	// ================================

	function _validateSplitInputs(
		address from,
		address operator,
		address[] calldata recipients,
		uint256[] calldata values
	) internal view {
		if (from != operator && !isApprovedForAll(from, operator)) {
			revert ERC1155MissingApprovalForAll(operator, from);
		}

		uint256 len = recipients.length;
		if (len != values.length) {
			revert ERC1155InvalidArrayLength(len, values.length);
		}
		if (len == 0) revert("EmptySplitArray");
		if (len > 50) revert("SplitArrayTooLarge");
	}

	/**
	 * @dev Handles the main loop logic for splitting a token into multiple parts.
	 * @param from The address the tokens are being split from.
	 * @param id The token ID being split.
	 * @param recipients The list of recipient addresses for each split.
	 * @param values The corresponding split values.
	 * @param fullBalance The sender’s full token balance for the given ID.
	 * @return totalSplit The total amount successfully split.
	 * @return splitIds The list of new token IDs created from the split.
	 */
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
			uint256 value = values[i];
			if (value == 0) revert("InvalidSplitAmount");

			totalSplit += value;
			if (totalSplit > fullBalance) {
				revert ERC1155InsufficientBalance(
					from,
					fullBalance,
					totalSplit,
					id
				);
			}

			// Increment nonce and assign split attributes
			uint256 newId = ++nonceCounter;
			_setRawTokenAttributes(newId, _intoParts(value, fullBalance, originalAttr));
			_addSFTValueForMergeSplit(recipients[i], newId, value);
			splitIds[i] = newId;

			unchecked {
				++i;
			}
		}
	}

	function _updateResidualAfterSplit(
		address from,
		uint256 id,
		uint256 totalSplit,
		uint256 fullBalance,
		bytes memory originalAttr
	) private returns (uint256) {
		uint256 remaining = fullBalance - totalSplit;

		if (remaining > 0) {
			// Residual part keeps the remainder with adjusted attributes
			bytes memory residualAttr = _intoParts(
				remaining,
				fullBalance,
				originalAttr
			);
			_setRawTokenAttributes(id, residualAttr);
			bytes memory splitAttr = _intoParts(
				totalSplit,
				fullBalance,
				originalAttr
			);
			_removeSFTValueForMergeSplitWithAttr(
				from,
				id,
				totalSplit,
				splitAttr
			);

			return id;
		} else {
			// Fully split token; remove metadata and nonce reference
			// $.addressToNonces[from].remove(id);
			bytes memory splitAttr = _intoParts(
				totalSplit,
				fullBalance,
				originalAttr
			);
			_removeSFTValueForMergeSplitWithAttr(
				from,
				id,
				totalSplit,
				splitAttr
			);
			// delete $.tokenAttributes[id];

			return 0;
		}
	}

	function splitTransferFrom(
		address from,
		uint256 id,
		address[] calldata recipients,
		uint256[] calldata values
	) external returns (uint256 finalNonce, uint256[] memory splitIds) {
		address operator = _msgSender();
		_validateSplitInputs(from, operator, recipients, values);

		uint256 fullBalance = balanceOf(from, id);
		if (fullBalance == 0) revert ERC1155InsufficientBalance(from, 0, 0, id);

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

		finalNonce = _updateResidualAfterSplit(
			from,
			id,
			totalSplit,
			fullBalance,
			originalAttr
		);

		emit TokensSplit(operator, from, id, recipients, values, totalSplit);
	}

	/**
	 * @notice
	 */
	function mergeTransferFrom(
		address from,
		address to,
		uint256[] calldata ids
	) external returns (uint256 nonce) {
		address operator = _msgSender();

		// --- Validation ---
		if (ids.length == 0) revert("EmptyMergeArray");
		if (to == address(0)) revert("InvalidRecipient");
		if (from != operator && !isApprovedForAll(from, operator)) {
			revert ERC1155MissingApprovalForAll(operator, from);
		}

		bytes memory mergedAttributes;
		uint256 totalAmount;

		for (uint256 i = ids.length; i > 0; ) {
			nonce = ids[i - 1];

			uint256 value = balanceOf(from, nonce);
			if (value == 0) revert("ZeroBalanceToken");

			bytes memory attr = getRawTokenAttributes[nonce];
			_ensureCanTransfer(nonce, from, to, attr);

			if (totalAmount == 0) {
				// seed mergedAttributes with the first token's attributes
				mergedAttributes = attr;
			} else {
				_ensureCanMerge(mergedAttributes, attr);

				// merge and produce new mergedAttributes
				mergedAttributes = _mergeAttr(
					mergedAttributes,
					totalAmount,
					attr,
					value
				);
			}

			totalAmount += value;

			// burn each source SFT from 'from' (we remove their balance)
			// $.addressToNonces[from].remove(nonce);
			_removeSFTValueForMergeSplit(from, nonce, value);
			// delete $.tokenAttributes[nonce];

			unchecked {
				--i;
			}
		}

		// update merged SFT for recipient
		addressToNonces[to].add(nonce);
		_setRawTokenAttributes(nonce, mergedAttributes);
		_addSFTValueForMergeSplit(to, nonce, totalAmount);

		emit TokensMerged(operator, from, to, ids, nonce, totalAmount);
	}

	// ================================
	// ========== Public Views ========
	// ================================

	/**
	 * @dev Returns the number of decimals used to get its user representation.
	 */
	function decimals() public view virtual returns (uint8) {
		return 18;
	}

	/**
	 * @dev Returns the list of nonces owned by an address.
	 * @param owner The address of the token owner.
	 * @return Array of nonces.
	 */
	function getNonces(address owner) public view returns (uint256[] memory) {
		return addressToNonces[owner].values();
	}

	/**
	 * @dev Returns the balance of the user with their token attributes.
	 * @param user The address of the user.
	 * @return Array of SftBalance containing nonce, amount, and attributes.
	 */
	function _sftBalance(
		address user
	) internal view returns (SftBalance[] memory) {
		uint256[] memory nonces = getNonces(user);
		SftBalance[] memory balance = new SftBalance[](nonces.length);

		for (uint256 i = 0; i < nonces.length; i++) {
			uint256 nonce = nonces[i];
			bytes memory attributes = getRawTokenAttributes[nonce];
			uint256 amount = balanceOf(user, nonce);

			balance[i] = SftBalance({
				nonce: nonce,
				amount: amount,
				attributes: attributes
			});
		}

		return balance;
	}

	// ================================
	// ========== Internal Writes =====
	// ================================

	/**
	 * @dev Mints a new Semi-Fungible Token (SFT) with specified attributes to a given address.
	 *
	 * This function performs the following operations:
	 * - Increments the internal nonce counter to generate a unique token ID.
	 * - Associates the provided `attributes` with the new token ID.
	 * - Mints `amount` tokens of the new ID to the `to` address.
	 *
	 * Emits a {TransferSingle} event via the ERC1155 `_mint` function.
	 *
	 * Requirements:
	 *
	 * - `to` cannot be the zero address.
	 *
	 * @param to The address receiving the newly minted tokens.
	 * @param amount The number of tokens to mint.
	 * @param attributes Arbitrary metadata associated with the token, stored as raw bytes.
	 * @return nonce The unique identifier (token ID) assigned to the newly minted token.
	 */
	function _mintSFT(
		address to,
		uint256 amount,
		bytes memory attributes
	) internal returns (uint256 nonce) {
		nonce = ++nonceCounter;
		_setRawTokenAttributes(nonce, attributes);

		_mint(to, nonce, amount, "");
	}

	/**
	 * @dev Overrides the _update function to handle address-to-nonce mapping and total supply adjustments.
	 * @param from The address sending tokens.
	 * @param to The address receiving tokens.
	 * @param ids The token IDs being transferred.
	 * @param values The values of tokens being transferred.
	 */
	function _update(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values
	) internal virtual override {
		for (uint256 i = 0; i < ids.length; i++) {
			uint256 id = ids[i];
			uint256 value = values[i];
			bytes memory attr = getRawTokenAttributes[id];

			_ensureCanTransfer(id, from, to, attr);

			if (from != address(0)) {
				uint256 fromBalance = balanceOf(from, id);
				if (fromBalance != value) {
					revert MustTransferAllSFTAmount(fromBalance);
				}
				addressToNonces[from].remove(id);
			}

			if (to == address(0)) {
				delete getRawTokenAttributes[id];
			} else {
				addressToNonces[to].add(id);
			}

			_updateHook(id, from, to, value, attr);
		}

		ERC1155Upgradeable._update(from, to, ids, values);
	}

	function _updateForMergeSplit(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values
	) internal {
		_updateForMergeSplitWithAttr(from, to, ids, values, new bytes[](0));
	}

	function _updateForMergeSplitWithAttr(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values,
		bytes[] memory overrideAttrs
	) internal {
		bool hasOverrides = overrideAttrs.length == ids.length;

		// pre-balances to update the nonce set accurately
		for (uint256 i; i < ids.length; i++) {
			_updateForMergeSplitItem(
				from,
				to,
				ids[i],
				values[i],
				i,
				hasOverrides,
				overrideAttrs
			);
		}

		// now do the actual balance updates
		ERC1155Upgradeable._update(from, to, ids, values);
	}

	function _updateForMergeSplitItem(
		address from,
		address to,
		uint256 id,
		uint256 value,
		uint256 index,
		bool hasOverrides,
		bytes[] memory overrideAttrs
	) private {
		bytes memory attr = hasOverrides && overrideAttrs[index].length > 0
			? overrideAttrs[index]
			: getRawTokenAttributes[id];
		bool removeEntireBalance = false;

		if (from != address(0)) {
			uint256 fromBal = balanceOf(from, id);
				if (fromBal < value) {
					revert ERC1155InsufficientBalance(from, fromBal, value, id);
				}
				if (fromBal == value) {
					addressToNonces[from].remove(id);
					removeEntireBalance = true;
				}
			}

			if (to == address(0)) {
				if (removeEntireBalance) {
					delete getRawTokenAttributes[id];
				}
			} else {
				uint256 toBal = balanceOf(to, id);
				if (toBal == 0 && value > 0) {
					addressToNonces[to].add(id);
				}
			}

		_updateHook(id, from, to, value, attr);
	}

	/**
	 * @dev Internally adds SFT value to `to` during a merge or split operation.
	 *      This does not mint new tokens or increase total supply.
	 *      Should only be used within merge/split logic to reflect balance redistribution.
	 */
	function _addSFTValueForMergeSplit(
		address to,
		uint256 nonce,
		uint256 amount
	) private {
		uint256[] memory ids = new uint256[](1);
		uint256[] memory values = new uint256[](1);
		ids[0] = nonce;
		values[0] = amount;

		_updateForMergeSplit(address(0), to, ids, values);
	}

	/**
	 * @dev Internally removes SFT value from `from` during a merge or split operation.
	 *      This does not burn tokens or decrease total supply.
	 *      Should only be used within merge/split logic to reflect balance redistribution.
	 */
	function _removeSFTValueForMergeSplit(
		address from,
		uint256 nonce,
		uint256 amount
	) private {
		uint256[] memory ids = new uint256[](1);
		uint256[] memory values = new uint256[](1);
		ids[0] = nonce;
		values[0] = amount;

		_updateForMergeSplit(from, address(0), ids, values);
	}

	function _removeSFTValueForMergeSplitWithAttr(
		address from,
		uint256 nonce,
		uint256 amount,
		bytes memory attr
	) private {
		uint256[] memory ids = new uint256[](1);
		uint256[] memory values = new uint256[](1);
		bytes[] memory overrideAttrs = new bytes[](1);
		ids[0] = nonce;
		values[0] = amount;
		overrideAttrs[0] = attr;

		_updateForMergeSplitWithAttr(
			from,
			address(0),
			ids,
			values,
			overrideAttrs
		);
	}

	/**
	 * @notice Sets or updates the raw attribute data of a specific SFT nonce.
	 * @dev This function writes arbitrary bytes to storage. It does not perform
	 *      validation on the format of `attr`; it is assumed the caller ensures
	 *      the structure is consistent with the protocol's expectations.
	 *
	 * @param nonce The unique token nonce or ID whose attributes are being updated.
	 * @param attr The raw byte-encoded attributes to associate with this token.
	 *
	 * @custom:security Use internally only. Never expose publicly to prevent
	 *                  arbitrary attribute tampering.
	 * @custom:events No event is emitted by default; inheriting contracts
	 *                 may override to emit `TokenAttributesUpdated` or similar.
	 */
	function _setRawTokenAttributes(
		uint256 nonce,
		bytes memory attr
	) private {
		require(attr.length > 0, "SFT: empty attributes not allowed");
		getRawTokenAttributes[nonce] = attr;
		emit TokenAttributesUpdated(nonce, attr);
	}

	function _updateTokenAttributes(
		address user,
		uint256 nonce,
		bytes memory attr
	) internal {
		uint256 balance = balanceOf(user, nonce);
		if (balance == 0) revert("SFT: No balance found at nonce");

		_setRawTokenAttributes(nonce, attr);
	}

	/**
	 * @notice Derives new token attributes when an SFT is split into fractional parts.
	 * @dev
	 * Called internally during a split or partial transfer to generate the correct
	 * proportional metadata for each resulting token.
	 *
	 * Implementations should define how the original token’s encoded attributes
	 * are proportionally adjusted or replicated among the new parts.
	 *
	 * Typical use cases:
	 *  - Scaling yield weights or reward multipliers according to split ratio.
	 *  - Cloning learner progress or credential data for content-bound sub-allocations.
	 *  - Allocating partial vesting or staking positions.
	 *
	 * @param value The amount assigned to the new split part.
	 * @param fullValue The total amount held by the original token before splitting.
	 * @param attributes The byte-encoded attribute data of the original token.
	 *
	 * @return newAttributes Byte-encoded attributes for the newly derived split token.
	 *
	 * @custom:requirements
	 * Implementations MUST preserve internal invariants (e.g., sum of yield weights
	 * across parts equals the original total) and maintain schema integrity.
	 *
	 * @custom:example
	 * ```
	 * // Example: proportional yield weight scaling
	 * function _intoParts(
	 *     uint256 value,
	 *     uint256 fullValue,
	 *     bytes memory attributes
	 * ) internal override returns (bytes memory) {
	 *     (uint256 yieldWeight, address content) = abi.decode(attributes, (uint256, address));
	 *     uint256 newWeight = (yieldWeight * value) / fullValue;
	 *     return abi.encode(newWeight, content);
	 * }
	 * ```
	 */
	function _intoParts(
		uint256 value,
		uint256 fullValue,
		bytes memory attributes
	) internal virtual returns (bytes memory);

	/**
	 * @notice Merges the attribute data of two SFTs into a new combined representation.
	 * @dev
	 * Invoked internally during token merges (e.g., content re-aggregation or portfolio
	 * consolidation) to compute unified attribute metadata for the resulting SFT.
	 *
	 * Implementations define how encoded attributes and proportional data are aggregated.
	 *
	 * Typical use cases:
	 *  - Weighted averaging of yield multipliers or rewards.
	 *  - Combining progress data for the same content or program.
	 *  - Consolidating vesting or staking positions into a single record.
	 *
	 * @param firstAttr Byte-encoded attributes of the first token.
	 * @param firstValue Amount or weight associated with the first token.
	 * @param secondAttr Byte-encoded attributes of the second token.
	 * @param secondValue Amount or weight associated with the second token.
	 *
	 * @return mergedAttributes Byte-encoded attributes for the newly merged token.
	 *
	 * @custom:requirements
	 * Implementations MUST ensure schema consistency and should revert if the
	 * attribute data are incompatible (e.g., different content bindings).
	 *
	 * @custom:example
	 * ```
	 * // Example: weighted yield merge
	 * function _mergeAttr(
	 *     bytes memory firstAttr,
	 *     uint256 firstValue,
	 *     bytes memory secondAttr,
	 *     uint256 secondValue
	 * ) internal override returns (bytes memory) {
	 *     (uint256 yieldA, address courseA) = abi.decode(firstAttr, (uint256, address));
	 *     (uint256 yieldB, address courseB) = abi.decode(secondAttr, (uint256, address));
	 *     if (courseA != courseB) revert UnAuthorizedSFTMerge(firstAttr, secondAttr, "Different content bindings");
	 *     uint256 totalWeight = firstValue + secondValue;
	 *     uint256 mergedYield = (yieldA * firstValue + yieldB * secondValue) / totalWeight;
	 *     return abi.encode(mergedYield, courseA);
	 * }
	 * ```
	 */
	function _mergeAttr(
		bytes memory firstAttr,
		uint256 firstValue,
		bytes memory secondAttr,
		uint256 secondValue
	) internal virtual returns (bytes memory);

	// ================================
	// ========== Overrides ===========
	// ================================

	/**
	 * @dev Overrides the supportsInterface function to include AccessControl interfaces.
	 * @param interfaceId The interface identifier, as specified in ERC-165.
	 * @return True if the contract implements the requested interface.
	 */
	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		virtual
		override(ERC1155Upgradeable, AccessControlUpgradeable, IERC165)
		returns (bool)
	{
		return super.supportsInterface(interfaceId);
	}

	/**
	 * @notice Verifies that the caller is authorized to transfer or update a given SFT.
	 * @dev Intended to be overridden by inheriting contracts to implement protocol-specific
	 *      access control (e.g., restricting transfers to approved operators, educators,
	 *      or platform-managed contracts).
	 *
	 * @param nonce The unique identifier of the SFT being transferred or modified.
	 * @param from The current owner of the SFT.
	 * @param to The address receiving or assuming ownership of the SFT.
	 * @param attributes The raw, byte-encoded metadata associated with the SFT.
	 *
	 * @custom:error UnAuthorizedSFTTransfer Thrown when the caller lacks permission
	 *               to perform the transfer or update.
	 */
	function _ensureCanTransfer(
		uint256 nonce,
		address from,
		address to,
		bytes memory attributes
	) internal view virtual;

	/**
	 * @notice Validates whether two SFTs can be merged based on their attributes.
	 * @dev Should be overridden by inheriting contracts to define merge compatibility rules,
	 *      such as matching content bindings, token types, or lifecycle states.
	 *
	 * @param firstAttr The byte-encoded attributes of the first SFT.
	 * @param secondAttr The byte-encoded attributes of the second SFT.
	 *
	 * @custom:error UnAuthorizedSFTMerge Thrown when the provided SFTs cannot be merged
	 *               due to incompatible attributes or access restrictions.
	 */
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

	uint256[50] private __gap;
}
