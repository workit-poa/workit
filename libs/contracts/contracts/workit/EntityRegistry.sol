// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title EntityRegistry
/// @notice Stores Proof-of-Activity entity accounting for quest creators, stakers, verifiers, and participants.
contract EntityRegistry is AccessControl {
	bytes32 public constant SCORE_MANAGER_ROLE = keccak256("SCORE_MANAGER_ROLE");
	uint256 public constant BPS_DENOMINATOR = 10_000;

	struct EntityData {
		uint256 entityScore;
		uint256 entityActivity;
		uint256 rewardMultiplierBps;
	}

	mapping(address => EntityData) private _entityData;

	error ZeroAddress();
	error InvalidMultiplier(uint256 multiplierBps);

	event EntityScoreUpdated(address indexed entity, uint256 newScore);
	event EntityActivityUpdated(address indexed entity, uint256 newActivity);
	event RewardMultiplierUpdated(address indexed entity, uint256 multiplierBps);

	constructor(address admin) {
		if (admin == address(0)) revert ZeroAddress();
		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(SCORE_MANAGER_ROLE, admin);
	}

	/// @notice Adds activity and score deltas for an entity.
	function recordActivity(
		address entity,
		uint256 scoreDelta,
		uint256 activityDelta
	) external onlyRole(SCORE_MANAGER_ROLE) {
		if (entity == address(0)) revert ZeroAddress();

		EntityData storage data = _entityData[entity];
		data.entityScore += scoreDelta;
		data.entityActivity += activityDelta;
		if (data.rewardMultiplierBps == 0) data.rewardMultiplierBps = BPS_DENOMINATOR;

		emit EntityScoreUpdated(entity, data.entityScore);
		emit EntityActivityUpdated(entity, data.entityActivity);
	}

	/// @notice Sets the reward multiplier in basis points for an entity.
	function setRewardMultiplier(
		address entity,
		uint256 multiplierBps
	) external onlyRole(SCORE_MANAGER_ROLE) {
		if (entity == address(0)) revert ZeroAddress();
		if (multiplierBps == 0 || multiplierBps > 50_000) {
			revert InvalidMultiplier(multiplierBps);
		}

		_entityData[entity].rewardMultiplierBps = multiplierBps;
		emit RewardMultiplierUpdated(entity, multiplierBps);
	}

	/// @notice Returns entity score.
	function entityScore(address entity) external view returns (uint256) {
		return _entityData[entity].entityScore;
	}

	/// @notice Returns entity activity count/weight.
	function entityActivity(address entity) external view returns (uint256) {
		return _entityData[entity].entityActivity;
	}

	/// @notice Returns reward multiplier in basis points (defaults to 10000 if never set).
	function rewardMultiplierBps(address entity) public view returns (uint256) {
		uint256 configured = _entityData[entity].rewardMultiplierBps;
		return configured == 0 ? BPS_DENOMINATOR : configured;
	}

	/// @notice Computes adjusted reward amount based on entity multiplier.
	function applyRewardMultiplier(
		address entity,
		uint256 baseReward
	) external view returns (uint256 adjustedReward) {
		uint256 multiplier = rewardMultiplierBps(entity);
		adjustedReward = (baseReward * multiplier) / BPS_DENOMINATOR;
	}

	/// @notice Returns full entity accounting struct.
	function entityData(address entity) external view returns (EntityData memory) {
		EntityData memory data = _entityData[entity];
		if (data.rewardMultiplierBps == 0) data.rewardMultiplierBps = BPS_DENOMINATOR;
		return data;
	}
}
