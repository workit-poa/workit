// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {Epochs} from "../../libraries/Epochs.sol";
import {IRewards} from "../../staking/IRewards.sol";
import {GainzEmission, Entities} from "../Gainz/GainzEmission.sol";
import {IHederaTokenService} from "../../interfaces/IHederaTokenService.sol";
import {IWorkitToken} from "./IWorkitToken.sol";
import {WorkitInfo} from "./WorkitInfo.sol";

/// @title WorkitHTSToken
/// @notice Gainz-style emission/accounting manager for an HTS-native WORKIT token.
/// @dev Assumes the configured HTS token uses this contract as treasury, so mints land here.
contract WorkitHTSToken is IWorkitToken, Initializable, OwnableUpgradeable {
	using Epochs for Epochs.Storage;
	using Entities for Entities.Value;

	int64 internal constant HTS_SUCCESS = 22;
	IHederaTokenService internal constant HTS =
		IHederaTokenService(address(0x167));

	/// @custom:storage-location erc7201:gainz.WorkitHTSToken.storage
	struct WorkitStorage {
		Epochs.Storage epochs;
		uint256 lastTimestamp;
		address rewardsCollector;
		address htsToken;
		Entities.Value entityFunds;
	}

	bytes32 private constant WORKIT_STORAGE_LOCATION =
		0x03c5f65f7aa0b9124ca64d1218dd61f7495e20ba6803471890cb0ec750bfef00;

	error ZeroAddress();
	error AmountTooLarge(uint256 amount);
	error HTSCallFailed(int64 responseCode);
	error InvalidCurrentTimestamp(uint256 lastTimestamp, uint256 currentTimestamp);
	error InvalidEmissionTimestamps(
		uint256 epoch,
		uint256 lastTimestamp,
		uint256 currentTimestamp
	);
	error RewardsCollectorNotSet();
	error InsufficientWorkitBudget(uint256 available, uint256 required);

	function _workitStorage()
		private
		pure
		returns (WorkitStorage storage $)
	{
		assembly {
			$.slot := WORKIT_STORAGE_LOCATION
		}
	}

	function initialize(address htsToken_, address owner_) external initializer {
		if (htsToken_ == address(0) || owner_ == address(0)) revert ZeroAddress();

		__Ownable_init(owner_);

		WorkitStorage storage $ = _workitStorage();
		$.htsToken = htsToken_;
		$.lastTimestamp = block.timestamp;
		$.epochs.initialize(24 hours);

		_mintFromTreasury(owner_, WorkitInfo.ICO_FUNDS);
		_mintFromTreasury(address(this), WorkitInfo.ECOSYSTEM_DISTRIBUTION_FUNDS);

		emit WorkitInitialized(
			owner_,
			htsToken_,
			WorkitInfo.ICO_FUNDS,
			WorkitInfo.ECOSYSTEM_DISTRIBUTION_FUNDS
		);
	}

	function setStakingRewardsCollector(address rewards) external onlyOwner {
		if (rewards == address(0)) revert ZeroAddress();

		WorkitStorage storage $ = _workitStorage();
		address previous = $.rewardsCollector;
		$.rewardsCollector = rewards;

		emit StakingRewardsCollectorUpdated(previous, rewards);
	}

	function mintWorkit() public override {
		WorkitStorage storage $ = _workitStorage();
		uint256 workitToEmit;

		($.lastTimestamp, workitToEmit) = _generateEmission();
		if (workitToEmit == 0) return;

		$.entityFunds.add(Entities.fromTotalValue(workitToEmit));
		emit EmissionGenerated($.epochs.currentEpoch(), workitToEmit, block.timestamp);

		uint256 stakingAmount = $.entityFunds.staking;
		if (stakingAmount == 0) return;
		if ($.rewardsCollector == address(0)) revert RewardsCollectorNotSet();

		_transferFromTreasury($.rewardsCollector, stakingAmount);
		$.entityFunds.staking = 0;

		(bool success, ) = $.rewardsCollector.call(
			abi.encode(IRewards.updateRewardReserve.selector)
		);
		require(success, "WorkitHTSToken: update reserve failed");

		emit StakingRewardsDispatched($.rewardsCollector, stakingAmount, block.timestamp);
	}

	function mintGainz() external override {
		mintWorkit();
	}

	function sendWorkit(
		address to,
		string memory entityName
	) external onlyOwner returns (uint256 amount) {
		if (to == address(0)) revert ZeroAddress();

		WorkitStorage storage $ = _workitStorage();
		bytes32 entity = keccak256(abi.encodePacked(entityName));

		if (entity == keccak256(abi.encodePacked("team"))) {
			amount = $.entityFunds.team;
			$.entityFunds.team = 0;
		} else if (entity == keccak256(abi.encodePacked("growth"))) {
			amount = $.entityFunds.growth;
			$.entityFunds.growth = 0;
		} else if (entity == keccak256(abi.encodePacked("liqIncentive"))) {
			amount = $.entityFunds.liqIncentive;
			$.entityFunds.liqIncentive = 0;
		}

		if (amount > 0) {
			_transferFromTreasury(to, amount);
		}

		emit WorkitSent(to, entity, amount);
	}

	function stakersWorkitToEmit() public view override returns (uint256 toEmit) {
		(, toEmit) = _generateEmission();

		toEmit =
			Entities.fromTotalValue(toEmit)
				.addReturn(_workitStorage().entityFunds)
				.staking;
	}

	function stakersGainzToEmit() external view override returns (uint256 toEmit) {
		return stakersWorkitToEmit();
	}

	function epochs() public view override returns (Epochs.Storage memory) {
		return _workitStorage().epochs;
	}

	function currentEpoch() public view returns (uint256) {
		return epochs().currentEpoch();
	}

	function workitTokenAddress() external view override returns (address token) {
		return _workitStorage().htsToken;
	}

	function availableEcosystemBudget() external view returns (uint256) {
		return IERC20(_workitStorage().htsToken).balanceOf(address(this));
	}

	function _computeEdgeEmissions(
		uint256 epoch,
		uint256 lastTimestamp,
		uint256 currentTimestamp
	) internal view returns (uint256) {
		if (currentTimestamp <= lastTimestamp) {
			revert InvalidCurrentTimestamp(lastTimestamp, currentTimestamp);
		}

		WorkitStorage storage $ = _workitStorage();
		(uint256 startTimestamp, uint256 endTimestamp) =
			$.epochs.epochEdgeTimestamps(epoch);

		uint256 upperBoundTime;
		uint256 lowerBoundTime;

		if (
			startTimestamp <= currentTimestamp &&
			currentTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp;
			lowerBoundTime = lastTimestamp <= startTimestamp
				? startTimestamp
				: lastTimestamp;
		} else if (
			startTimestamp <= lastTimestamp &&
			lastTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp <= endTimestamp
				? currentTimestamp
				: endTimestamp;
			lowerBoundTime = lastTimestamp;
		} else {
			revert InvalidEmissionTimestamps(
				epoch,
				lastTimestamp,
				currentTimestamp
			);
		}

		uint256 rawEmission = GainzEmission.throughTimeRange(
			epoch,
			upperBoundTime - lowerBoundTime,
			$.epochs.epochLength
		);

		return rawEmission / WorkitInfo.EMISSION_SCALE;
	}

	function _generateEmission()
		private
		view
		returns (uint256 lastTimestamp, uint256 workitToEmit)
	{
		WorkitStorage storage $ = _workitStorage();
		Epochs.Storage storage _epochs = $.epochs;

		uint256 currentTimestamp = block.timestamp;
		lastTimestamp = $.lastTimestamp;

		if (lastTimestamp < currentTimestamp) {
			uint256 lastGenerateEpoch = _epochs.computeEpoch(lastTimestamp);
			workitToEmit = _computeEdgeEmissions(
				lastGenerateEpoch,
				lastTimestamp,
				currentTimestamp
			);

			uint256 _currentEpoch = _epochs.currentEpoch();
			if (_currentEpoch > lastGenerateEpoch) {
				uint256 intermediateEpochs = _currentEpoch -
					lastGenerateEpoch -
					1;

				if (intermediateEpochs > 0) {
					workitToEmit +=
						GainzEmission.throughEpochRange(
							lastGenerateEpoch + 1,
							_currentEpoch
						) /
						WorkitInfo.EMISSION_SCALE;
				}

				workitToEmit += _computeEdgeEmissions(
					_currentEpoch,
					lastTimestamp,
					currentTimestamp
				);
			}

			lastTimestamp = currentTimestamp;
		}
	}

	function _mintFromTreasury(address to, uint256 amount) private {
		if (to == address(0)) revert ZeroAddress();
		if (amount == 0) return;

		WorkitStorage storage $ = _workitStorage();
		uint64 amount64 = _toUint64(amount);
		bytes[] memory metadata = new bytes[](0);

		(int64 rc, , ) = HTS.mintToken($.htsToken, amount64, metadata);
		_requireHTSSuccess(rc);

		if (to != address(this)) {
			_transferToken($.htsToken, address(this), to, amount);
		}
	}

	function _transferFromTreasury(address to, uint256 amount) private {
		if (to == address(0)) revert ZeroAddress();
		if (amount == 0) return;

		WorkitStorage storage $ = _workitStorage();
		uint256 available = IERC20($.htsToken).balanceOf(address(this));
		if (available < amount) {
			revert InsufficientWorkitBudget(available, amount);
		}

		_transferToken($.htsToken, address(this), to, amount);
	}

	function _transferToken(
		address token,
		address from,
		address to,
		uint256 amount
	) private {
		int64 signedAmount = _toInt64(amount);
		int64 rc = HTS.transferToken(token, from, to, signedAmount);
		_requireHTSSuccess(rc);
	}

	function _toUint64(uint256 value) private pure returns (uint64) {
		if (value > type(uint64).max) revert AmountTooLarge(value);
		return uint64(value);
	}

	function _toInt64(uint256 value) private pure returns (int64) {
		if (value > uint256(uint64(type(int64).max))) {
			revert AmountTooLarge(value);
		}
		return int64(uint64(value));
	}

	function _requireHTSSuccess(int64 responseCode) private pure {
		if (responseCode != HTS_SUCCESS) revert HTSCallFailed(responseCode);
	}
}
