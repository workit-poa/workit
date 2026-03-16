// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GTokenLib} from "./GTokenLib.sol";
import {HybridSFT} from "../../abstracts/HybridSFT.sol";
import {Epochs} from "../../libraries/Epochs.sol";
import {IGToken} from "./IGToken.sol";
import {Math} from "../../libraries/Math.sol";

/// @title GToken Contract
/// @notice WorkIt governance position token implemented as Hybrid HTS NFT + EVM metadata.
contract GToken is IGToken, HybridSFT {
	using GTokenLib for IGToken.Attributes;
	using GTokenLib for bytes;
	using Epochs for Epochs.Storage;

	bytes32 public constant UPDATE_ROLE = keccak256("UPDATE_ROLE");
	bytes32 public constant BURN_ROLE = keccak256("BURN_ROLE");

	uint256 public override totalStakeWeight;
	mapping(address => uint256) public override pairSupply;
	uint256 public override totalSupply;
	Epochs.Storage private _epochs;

	error InvalidAddress();
	error InvalidEpochLength();

	constructor(
		address admin,
		uint256 epochLength
	) HybridSFT("WorkIt Governance Token", "WGT", admin) {
		if (admin == address(0)) revert InvalidAddress();
		if (epochLength == 0) revert InvalidEpochLength();

		_grantRole(MINTER_ROLE, admin);
		_grantRole(TRANSFER_ROLE, admin);
		_grantRole(UPDATE_ROLE, admin);
		_grantRole(BURN_ROLE, admin);

		_epochs.initialize(epochLength);
	}

	/// @notice Mints a new GToken position for the given address.
	function mintGToken(
		address to,
		uint256 rewardPerShare,
		uint256 epochsLocked,
		LiquidityInfo memory lpDetails
	) external onlyRole(MINTER_ROLE) returns (uint256) {
		uint256 currentEpoch = _epochs.currentEpoch();

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

		return _mintPosition(to, attributes.supply(), abi.encode(attributes));
	}

	function burn(
		address user,
		uint256 nonce,
		uint256 supply
	) external onlyRole(BURN_ROLE) {
		uint256 amount = balanceOf(user, nonce);
		if (amount == 0) revert ZeroBalanceToken();
		if (supply != amount) revert MustTransferAllSFTAmount(amount);

		_burnPosition(nonce);
	}

	function burn(uint256 nonce) external {
		uint256 amount = balanceOf(msg.sender, nonce);
		require(amount > 0, "No tokens at nonce");

		_burnPosition(nonce);
	}

	function update(
		address user,
		uint256 nonce,
		IGToken.Attributes memory attr
	) external onlyRole(UPDATE_ROLE) returns (uint256) {
		require(balanceOf(user, nonce) > 0, "Not found");

		IGToken.Attributes memory existing = getRawTokenAttributes[nonce].decode();
		totalStakeWeight -= existing.stakeWeight;

		attr = attr.computeStakeWeight(_epochs.currentEpoch());
		totalStakeWeight += attr.stakeWeight;
		_updateTokenAttributes(user, nonce, abi.encode(attr));

		return nonce;
	}

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

		attr.stakeWeight = (fullAttr.stakeWeight * value) / fullValue;

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

		if (B.epochStaked < A.epochStaked) {
			A.epochStaked = B.epochStaked;
		}

		if (B.epochsLocked > A.epochsLocked) {
			A.epochsLocked = B.epochsLocked;
		}

		uint256 newLastClaimEpoch = (A.lastClaimEpoch *
			A.stakeWeight +
			B.lastClaimEpoch *
			B.stakeWeight) / (A.stakeWeight + B.stakeWeight);

		A.lastClaimEpoch = newLastClaimEpoch;

		A.stakeWeight = A.stakeWeight + B.stakeWeight;

		A.lpDetails.liquidity = A.lpDetails.liquidity + B.lpDetails.liquidity;
		A.lpDetails.liqValue = A.lpDetails.liqValue + B.lpDetails.liqValue;

		return abi.encode(A);
	}

	function _ensureCanTransfer(
		uint256,
		address,
		address,
		bytes memory
	) internal view override {}

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

		if (from == address(0)) {
			totalStakeWeight += stakeWeight;
			totalSupply += value;
			pairSupply[pair] += value;
		} else if (to == address(0)) {
			totalStakeWeight -= stakeWeight;
			totalSupply -= value;
			pairSupply[pair] -= value;
		}

		emit GTokenTransfer(from, to, id, stakeWeight, value);
	}

}
