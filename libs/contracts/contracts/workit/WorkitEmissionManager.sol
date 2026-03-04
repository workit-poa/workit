// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {WorkitToken} from "../gainzswap/tokens/Workit/WorkitToken.sol";
import {Epochs} from "../gainzswap/libraries/Epochs.sol";
import {GainzEmission, Entities} from "../gainzswap/tokens/Gainz/GainzEmission.sol";
import {IWorkitEmissionManager} from "./interfaces/IWorkitEmissionManager.sol";

contract WorkitEmissionManager is AccessControl, IWorkitEmissionManager {
	using Epochs for Epochs.Storage;
	using Entities for Entities.Value;

	bytes32 public constant STAKING_MANAGER_ROLE = keccak256("STAKING_MANAGER_ROLE");
	bytes32 public constant TREASURY_MANAGER_ROLE = keccak256("TREASURY_MANAGER_ROLE");

	struct EmissionState {
		Epochs.Storage epochs;
		uint256 lastTimestamp;
		address staking;
		address treasury;
		Entities.Value entityFunds;
	}

	WorkitToken public immutable workit;

	EmissionState private _state;

	event StakingUpdated(address indexed previousStaking, address indexed staking);
	event TreasuryUpdated(address indexed previousTreasury, address indexed treasury);
	event EmissionGenerated(uint256 indexed epoch, uint256 amount, uint256 timestamp);
	event StakingRewardsDispatched(address indexed staking, uint256 amount, uint256 timestamp);
	event EntityFundsClaimed(Entity indexed entity, address indexed to, uint256 amount);

	error ZeroAddress();
	error InvalidTimestampRange(uint256 lastTimestamp, uint256 currentTimestamp);
	error InvalidTimestamps(uint256 epoch, uint256 lastTimestamp, uint256 currentTimestamp);

	constructor(
		address admin,
		address workitToken,
		address staking_,
		address treasury_,
		uint256 epochLength
	) {
		if (
			admin == address(0) ||
			workitToken == address(0) ||
			staking_ == address(0) ||
			treasury_ == address(0)
		) {
			revert ZeroAddress();
		}

		workit = WorkitToken(workitToken);

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(STAKING_MANAGER_ROLE, admin);
		_grantRole(TREASURY_MANAGER_ROLE, admin);
		_grantRole(TREASURY_MANAGER_ROLE, treasury_);

		_state.staking = staking_;
		_state.treasury = treasury_;
		_state.lastTimestamp = block.timestamp;
		_state.epochs.initialize(epochLength == 0 ? 24 hours : epochLength);
	}

	function setStaking(
		address staking_
	) external onlyRole(STAKING_MANAGER_ROLE) {
		if (staking_ == address(0)) revert ZeroAddress();

		address previousStaking = _state.staking;
		_state.staking = staking_;

		emit StakingUpdated(previousStaking, staking_);
	}

	function setTreasury(
		address treasury_
	) external override onlyRole(TREASURY_MANAGER_ROLE) {
		if (treasury_ == address(0)) revert ZeroAddress();

		address previousTreasury = _state.treasury;
		if (previousTreasury != address(0)) {
			_revokeRole(TREASURY_MANAGER_ROLE, previousTreasury);
		}
		_state.treasury = treasury_;
		_grantRole(TREASURY_MANAGER_ROLE, treasury_);

		emit TreasuryUpdated(previousTreasury, treasury_);
	}

	function mintForStaking() external override returns (uint256 minted) {
		(uint256 nextTimestamp, uint256 totalEmission) = _generateEmission();
		_state.lastTimestamp = nextTimestamp;
		if (totalEmission == 0) return 0;

		_state.entityFunds.add(Entities.fromTotalValue(totalEmission));

		emit EmissionGenerated(currentEpoch(), totalEmission, block.timestamp);

		minted = _state.entityFunds.staking;
		if (minted == 0) return 0;

		_state.entityFunds.staking = 0;
		workit.mint(_state.staking, minted);

		emit StakingRewardsDispatched(_state.staking, minted, block.timestamp);
	}

	function claimEntityFunds(
		Entity entity,
		address to
	) external override onlyRole(TREASURY_MANAGER_ROLE) returns (uint256 amount) {
		if (to == address(0)) revert ZeroAddress();

		if (entity == Entity.Team) {
			amount = _state.entityFunds.team;
			_state.entityFunds.team = 0;
		} else if (entity == Entity.Growth) {
			amount = _state.entityFunds.growth;
			_state.entityFunds.growth = 0;
		} else {
			amount = _state.entityFunds.liqIncentive;
			_state.entityFunds.liqIncentive = 0;
		}

		if (amount > 0) {
			workit.mint(to, amount);
			emit EntityFundsClaimed(entity, to, amount);
		}
	}

	function pendingStakingEmission() external view override returns (uint256) {
		(, uint256 toEmit) = _generateEmission();
		return
			Entities.fromTotalValue(toEmit)
				.addReturn(_state.entityFunds)
				.staking;
	}

	function epochs() external view override returns (Epochs.Storage memory) {
		return _state.epochs;
	}

	function currentEpoch() public view override returns (uint256) {
		return _state.epochs.currentEpoch();
	}

	function staking() external view returns (address) {
		return _state.staking;
	}

	function treasury() external view returns (address) {
		return _state.treasury;
	}

	function entityFunds() external view returns (Entities.Value memory) {
		return _state.entityFunds;
	}

	function _computeEdgeEmissions(
		uint256 epoch,
		uint256 lastTimestamp,
		uint256 currentTimestamp
	) internal view returns (uint256) {
		if (currentTimestamp <= lastTimestamp) {
			revert InvalidTimestampRange(lastTimestamp, currentTimestamp);
		}

		(uint256 startTimestamp, uint256 endTimestamp) = _state
			.epochs
			.epochEdgeTimestamps(epoch);

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
			revert InvalidTimestamps(epoch, lastTimestamp, currentTimestamp);
		}

		return
			GainzEmission.throughTimeRange(
				epoch,
				upperBoundTime - lowerBoundTime,
				_state.epochs.epochLength
			);
	}

	function _generateEmission()
		internal
		view
		returns (uint256 nextTimestamp, uint256 toEmit)
	{
		nextTimestamp = _state.lastTimestamp;
		uint256 currentTimestamp = block.timestamp;
		if (nextTimestamp >= currentTimestamp) return (nextTimestamp, 0);

		uint256 lastEpoch = _state.epochs.computeEpoch(nextTimestamp);
		toEmit = _computeEdgeEmissions(lastEpoch, nextTimestamp, currentTimestamp);

		uint256 currentEpoch_ = _state.epochs.currentEpoch();
		if (currentEpoch_ > lastEpoch) {
			uint256 intermediateEpochs = currentEpoch_ - lastEpoch - 1;
			if (intermediateEpochs > 0) {
				toEmit += GainzEmission.throughEpochRange(lastEpoch + 1, currentEpoch_);
			}

			toEmit += _computeEdgeEmissions(currentEpoch_, nextTimestamp, currentTimestamp);
		}

		nextTimestamp = currentTimestamp;
	}
}
