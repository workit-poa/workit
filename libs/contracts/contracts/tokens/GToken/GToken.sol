// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GTokenLib} from "./GTokenLib.sol";
import {SFT} from "../../abstracts/SFT.sol";
import {Epochs} from "../../libraries/Epochs.sol";
import {Math} from "../../libraries/Math.sol";
import {IGToken} from "./IGToken.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

/// @title GToken Contract
/// @notice This contract handles the minting of governance tokens (GToken) used in the Gainz platform.
/// @dev The contract extends a semi-fungible token (SFT) and uses GToken attributes for staking.
contract GToken is IGToken, SFT, UUPSUpgradeable {
	using GTokenLib for IGToken.Attributes;
	using GTokenLib for bytes;
	using Epochs for Epochs.Storage;

	bytes32 public constant UPDATE_ROLE = keccak256("UPDATE_ROLE");
	bytes32 public constant BURN_ROLE = keccak256("BURN_ROLE"); // For backwards compability

	uint256 public override totalStakeWeight;
	mapping(address => uint256) public override pairSupply;
	uint256 public override totalSupply;
	Epochs.Storage private _epochs;

	constructor() {
		_disableInitializers();
	}

	/// @notice Constructor to initialize the GToken contract.
	/// @dev Sets the name and symbol of the SFT for GToken.
	function initialize(address admin, uint256 epochLength) external initializer {
		__SFT_init("GainzSwap Governance Token", "GToken", admin);
		require(admin != address(0), "GToken: admin = zero");
		require(epochLength > 0, "GToken: epochLength = zero");

		_epochs.initialize(epochLength);

		_grantRole(MINTER_ROLE, admin);
		_grantRole(TRANSFER_ROLE, admin);
		_grantRole(UPDATE_ROLE, admin);
		_grantRole(BURN_ROLE, admin);
	}

	/// @notice Mints a new GToken for the given address.
	/// @dev The function encodes GToken attributes and mints the token with those attributes.
	/// @param to The address that will receive the minted GToken.
	/// @param rewardPerShare The reward per share at the time of minting.
	/// @param epochsLocked The number of epochs for which the GTokens are locked.
	/// @param lpDetails An LiquidityInfo struct representing the GToken payment.
	/// @return uint256 The token ID of the newly minted GToken.
	function mintGToken(
		address to,
		uint256 rewardPerShare,
		uint256 epochsLocked,
		LiquidityInfo memory lpDetails
	) external onlyRole(MINTER_ROLE) returns (uint256) {
		uint256 currentEpoch = _epochs.currentEpoch();

		// Create GToken attributes and compute the stake weight
		IGToken.Attributes memory attributes = IGToken
			.Attributes({
				rewardPerShare: rewardPerShare,
				epochStaked: currentEpoch,
				lastClaimEpoch: currentEpoch,
				epochsLocked: epochsLocked,
				stakeWeight: 0,
				lpDetails: lpDetails
			})
			.computeStakeWeight(currentEpoch);

		// Mint the GToken with the specified attributes and return the token ID
		return _mintSFT(to, attributes.supply(), abi.encode(attributes));
	}

	function burn(
		address user,
		uint256 nonce,
		uint256 supply
	) external onlyRole(BURN_ROLE) {
		_burn(user, nonce, supply);
	}

	function burn(uint256 nonce) external {
		uint256 balance = balanceOf(msg.sender, nonce);
		require(balance > 0, "No tokens at nonce");

		_burn(msg.sender, nonce, balance);
	}

	function update(
		address user,
		uint256 nonce,
		IGToken.Attributes memory attr
	) external onlyRole(UPDATE_ROLE) returns (uint256) {
		require(balanceOf(user, nonce) > 0, "Not found");

		IGToken.Attributes memory existing = getRawTokenAttributes[nonce].decode();

		// Burning so stakeWeight global total will update
		totalStakeWeight -= existing.stakeWeight;

		// recomputing stake weight
		attr = attr.computeStakeWeight(_epochs.currentEpoch());

		totalStakeWeight += attr.stakeWeight;
		_updateTokenAttributes(user, nonce, abi.encode(attr));

		return nonce;
	}

	/**
	 * @notice Retrieves the governance token balance and attributes for a specific user at a given nonce.
	 * @dev This function checks if the user has a Semi-Fungible Token (SFT) at the provided nonce.
	 * If the user does not have a balance at the specified nonce, the function will revert with an error.
	 * The function then returns the governance balance for the user at that nonce.
	 *
	 * @param user The address of the user whose balance is being queried.
	 * @param nonce The nonce for the specific GToken to retrieve.
	 *
	 * @return Balance A struct containing the nonce, amount, and attributes of the GToken.
	 *
	 * Requirements:
	 * - The user must have a GToken balance at the specified nonce.
	 */
	function getBalanceAt(
		address user,
		uint256 nonce
	) public view returns (Balance memory) {
		uint256 amount = balanceOf(user, nonce);
		require(amount > 0, "No GToken balance found at nonce for user");

		return _packageBalance(nonce, amount, getRawTokenAttributes[nonce]);
	}

	function getAttributes(
		uint256 nonce
	) external view returns (IGToken.Attributes memory) {
		return getRawTokenAttributes[nonce].decode();
	}

	function epochs() external view returns (Epochs.Storage memory) {
		return _epochs;
	}

	function _packageBalance(
		uint256 nonce,
		uint256 amount,
		bytes memory attr
	) private view returns (Balance memory) {
		IGToken.Attributes memory attrUnpacked = attr.decode();
		uint256 votePower = attrUnpacked.votePower(_epochs.currentEpoch());

		return
			Balance({
				nonce: nonce,
				amount: amount,
				attributes: attrUnpacked,
				votePower: votePower
			});
	}

	/**
	 * @notice Retrieves the entire GToken balance and attributes for a specific user.
	 * @dev This function queries all Semi-Fungible Tokens (SFTs) held by the user and decodes
	 * the attributes for each GToken.
	 *
	 * @param user The address of the user whose balances are being queried.
	 *
	 * @return Balance[] An array of structs, each containing the nonce, amount, and attributes
	 * of the user's GToken.
	 */
	function getBalance(address user) public view returns (Balance[] memory) {
		SftBalance[] memory _sftBals = _sftBalance(user);
		Balance[] memory balance = new Balance[](_sftBals.length);

		for (uint256 i = 0; i < _sftBals.length; i++) {
			SftBalance memory _sftBal = _sftBals[i];

			balance[i] = _packageBalance(
				_sftBal.nonce,
				_sftBal.amount,
				_sftBal.attributes
			);
		}

		return balance;
	}

	function _intoParts(
		uint256 value,
		uint256 fullValue,
		bytes memory attributes
	) internal pure override returns (bytes memory) {
		IGToken.Attributes memory fullAttr = attributes.decode();
		IGToken.Attributes memory attr = fullAttr;

		// Proportional stake weight
		attr.stakeWeight = (fullAttr.stakeWeight * value) / fullValue;

		// Proportional LP liquidity + value
		attr.lpDetails.liquidity =
			(fullAttr.lpDetails.liquidity * value) /
			fullValue;

		attr.lpDetails.liqValue =
			(fullAttr.lpDetails.liqValue * value) /
			fullValue;

		return abi.encode(attr);
	}

	function _mergeAttr(
		bytes memory firstAttr,
		uint256 firstValue,
		bytes memory secondAttr,
		uint256 secondValue
	) internal pure override returns (bytes memory) {
		IGToken.Attributes memory A = firstAttr.decode();
		IGToken.Attributes memory B = secondAttr.decode();

		A.rewardPerShare = Math.weightedAverageRoundUp(
			A.rewardPerShare,
			firstValue,
			B.rewardPerShare,
			secondValue
		);

		// -----------------------------
		// epochStaked MERGE  (taking earliest)
		// -----------------------------
		if (B.epochStaked < A.epochStaked) {
			A.epochStaked = B.epochStaked;
		}

		// -----------------------------
		//  epochsLocked MERGE (taking strictest / max)
		// -----------------------------
		if (B.epochsLocked > A.epochsLocked) {
			A.epochsLocked = B.epochsLocked;
		}

		// -----------------------------
		//  lastClaimEpoch MERGE
		// safest rule: take weighted average by stake weight
		// -----------------------------
		uint256 newLastClaimEpoch = (A.lastClaimEpoch *
			A.stakeWeight +
			B.lastClaimEpoch *
			B.stakeWeight) / (A.stakeWeight + B.stakeWeight);

		A.lastClaimEpoch = newLastClaimEpoch;

		// -----------------------------
		//  stakeWeight MERGE (sum)
		// -----------------------------
		A.stakeWeight = A.stakeWeight + B.stakeWeight;

		// -----------------------------
		//  LiquidityInfo MERGE
		// -----------------------------
		A.lpDetails.liquidity = A.lpDetails.liquidity + B.lpDetails.liquidity;
		A.lpDetails.liqValue = A.lpDetails.liqValue + B.lpDetails.liqValue;

		// token0, token1, pair remain the same (validated above)

		return abi.encode(A);
	}

	function _ensureCanTransfer(
		uint256 nonce,
		address from,
		address to,
		bytes memory attributes
	) internal view override {
		// All tokens in all state can be transferred
	}

	function _ensureCanMerge(
		bytes memory firstAttr,
		bytes memory secondAttr
	) internal pure override {
		LiquidityInfo memory first = firstAttr.decode().lpDetails;
		LiquidityInfo memory second = secondAttr.decode().lpDetails;

		if (first.pair != second.pair)
			revert UnAuthorizedSFTMerge(
				firstAttr,
				secondAttr,
				"Liquidity Pool Mismatch"
			);
	}

	function _updateHook(
		uint256 id,
		address from,
		address to,
		uint256 value,
		bytes memory attributes
	) internal override {
		IGToken.Attributes memory attr = attributes.decode();

		uint256 stakeWeight = attr.stakeWeight;
		address pair = attr.lpDetails.pair;

		// Mint
		if (from == address(0)) {
			totalStakeWeight += stakeWeight;
			totalSupply += value;
			pairSupply[pair] += value;
		}
		// Burn
		else if (to == address(0)) {
			totalStakeWeight -= stakeWeight;
			totalSupply -= value;
			pairSupply[pair] -= value;
		}

		emit GTokenTransfer(from, to, id, stakeWeight, value);
	}

	function _authorizeUpgrade(
		address
	) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

	uint256[50] private __gap;
}
