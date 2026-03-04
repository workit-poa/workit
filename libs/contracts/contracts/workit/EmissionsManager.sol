// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {EntityRegistry} from "./EntityRegistry.sol";
import {WorkitToken} from "./WorkitToken.sol";

/// @title EmissionsManager
/// @notice Epoch-based WORKIT emissions for staked GToken liquidity positions.
/// @dev Rewards are proportional to user stake within each pool.
contract EmissionsManager is AccessControl {
	bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
	bytes32 public constant STAKING_ROLE = keccak256("STAKING_ROLE");

	uint256 public constant ACC_REWARD_PRECISION = 1e24;

	struct PoolState {
		uint256 emissionRatePerEpoch;
		uint256 totalStaked;
		uint256 accRewardPerShare;
		uint256 lastUpdatedEpoch;
		bool enabled;
		bool initialized;
	}

	struct UserPosition {
		uint256 amount;
		uint256 rewardDebt;
		uint256 pendingRewards;
	}

	WorkitToken public immutable workitToken;
	EntityRegistry public entityRegistry;
	uint256 public immutable epochDuration;
	uint256 public immutable epochZero;

	mapping(uint256 => PoolState) public pools;
	mapping(uint256 => mapping(address => UserPosition)) public userPositions;

	error ZeroAddress();
	error ZeroAmount();
	error InvalidEpochDuration();
	error InsufficientStake(uint256 requested, uint256 available);
	error PoolNotEnabled(uint256 poolId);

	event PoolConfigured(
		uint256 indexed poolId,
		uint256 emissionRatePerEpoch,
		bool enabled
	);
	event StakeSynced(
		uint256 indexed poolId,
		address indexed user,
		uint256 newUserStake,
		uint256 newPoolStake
	);
	event RewardsClaimed(
		uint256 indexed poolId,
		address indexed user,
		address indexed to,
		uint256 amount
	);
	event EntityRegistryUpdated(address indexed entityRegistry);

	constructor(
		address admin,
		WorkitToken token,
		uint256 epochDurationSeconds,
		uint256 epochZeroTimestamp
	) {
		if (admin == address(0) || address(token) == address(0)) {
			revert ZeroAddress();
		}
		if (epochDurationSeconds == 0) revert InvalidEpochDuration();

		workitToken = token;
		epochDuration = epochDurationSeconds;
		epochZero = epochZeroTimestamp == 0
			? block.timestamp
			: epochZeroTimestamp;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(GOVERNANCE_ROLE, admin);
		_grantRole(STAKING_ROLE, admin);
	}

	/// @notice Returns the current epoch index.
	function currentEpoch() public view returns (uint256) {
		if (block.timestamp <= epochZero) return 0;
		return (block.timestamp - epochZero) / epochDuration;
	}

	/// @notice Governance configures per-pool emissions rate.
	function configurePool(
		uint256 poolId,
		uint256 emissionRatePerEpoch,
		bool enabled
	) external onlyRole(GOVERNANCE_ROLE) {
		_updatePool(poolId);
		PoolState storage pool = pools[poolId];
		pool.emissionRatePerEpoch = emissionRatePerEpoch;
		pool.enabled = enabled;
		emit PoolConfigured(poolId, emissionRatePerEpoch, enabled);
	}

	/// @notice Sets optional entity registry for reward multiplier application.
	function setEntityRegistry(
		EntityRegistry registry
	) external onlyRole(GOVERNANCE_ROLE) {
		entityRegistry = registry;
		emit EntityRegistryUpdated(address(registry));
	}

	/// @notice Syncs an increase in user stake, called by staking module.
	function onStake(
		uint256 poolId,
		address user,
		uint256 amount
	) external onlyRole(STAKING_ROLE) {
		if (user == address(0)) revert ZeroAddress();
		if (amount == 0) revert ZeroAmount();

		_updatePool(poolId);
		PoolState storage pool = pools[poolId];
		if (!pool.enabled) revert PoolNotEnabled(poolId);

		UserPosition storage position = userPositions[poolId][user];
		position.pendingRewards += _pendingFromPosition(pool, position);

		position.amount += amount;
		pool.totalStaked += amount;
		position.rewardDebt = _rewardDebt(pool, position.amount);

		emit StakeSynced(poolId, user, position.amount, pool.totalStaked);
	}

	/// @notice Syncs a decrease in user stake, called by staking module.
	function onUnstake(
		uint256 poolId,
		address user,
		uint256 amount
	) external onlyRole(STAKING_ROLE) {
		if (user == address(0)) revert ZeroAddress();
		if (amount == 0) revert ZeroAmount();

		_updatePool(poolId);
		PoolState storage pool = pools[poolId];
		UserPosition storage position = userPositions[poolId][user];

		if (amount > position.amount) {
			revert InsufficientStake(amount, position.amount);
		}

		position.pendingRewards += _pendingFromPosition(pool, position);
		position.amount -= amount;
		pool.totalStaked -= amount;
		position.rewardDebt = _rewardDebt(pool, position.amount);

		emit StakeSynced(poolId, user, position.amount, pool.totalStaked);
	}

	/// @notice Claim by end user directly.
	function claim(uint256 poolId, address to) external returns (uint256 claimed) {
		claimed = _claim(poolId, msg.sender, to);
	}

	/// @notice Claim for a user through staking orchestrator.
	function claimFor(
		uint256 poolId,
		address user,
		address to
	) external onlyRole(STAKING_ROLE) returns (uint256 claimed) {
		claimed = _claim(poolId, user, to);
	}

	/// @notice Returns claimable rewards for user in a pool at current epoch.
	function pendingReward(
		uint256 poolId,
		address user
	) external view returns (uint256) {
		PoolState memory pool = pools[poolId];
		UserPosition memory position = userPositions[poolId][user];
		if (!pool.initialized) return position.pendingRewards;

		if (pool.totalStaked > 0) {
			uint256 epochNow = currentEpoch();
			if (epochNow > pool.lastUpdatedEpoch) {
				uint256 epochsElapsed = epochNow - pool.lastUpdatedEpoch;
				uint256 rewardAccrued = epochsElapsed * pool.emissionRatePerEpoch;
				pool.accRewardPerShare +=
					(rewardAccrued * ACC_REWARD_PRECISION) /
					pool.totalStaked;
			}
		}

		return
			position.pendingRewards +
			((position.amount * pool.accRewardPerShare) / ACC_REWARD_PRECISION) -
			position.rewardDebt;
	}

	function _claim(
		uint256 poolId,
		address user,
		address to
	) internal returns (uint256 claimed) {
		if (to == address(0) || user == address(0)) revert ZeroAddress();

		_updatePool(poolId);
		PoolState storage pool = pools[poolId];
		UserPosition storage position = userPositions[poolId][user];

		uint256 pending = position.pendingRewards +
			_pendingFromPosition(pool, position);
		if (pending == 0) {
			position.rewardDebt = _rewardDebt(pool, position.amount);
			return 0;
		}

		position.pendingRewards = 0;
		position.rewardDebt = _rewardDebt(pool, position.amount);

		if (address(entityRegistry) != address(0)) {
			pending = entityRegistry.applyRewardMultiplier(user, pending);
		}

		workitToken.mint(to, pending);
		emit RewardsClaimed(poolId, user, to, pending);
		return pending;
	}

	function _updatePool(uint256 poolId) internal {
		PoolState storage pool = pools[poolId];
		uint256 epochNow = currentEpoch();

		if (!pool.initialized) {
			pool.initialized = true;
			pool.lastUpdatedEpoch = epochNow;
			return;
		}
		if (epochNow <= pool.lastUpdatedEpoch) return;

		if (pool.totalStaked == 0 || pool.emissionRatePerEpoch == 0) {
			pool.lastUpdatedEpoch = epochNow;
			return;
		}

		uint256 epochsElapsed = epochNow - pool.lastUpdatedEpoch;
		uint256 rewardAccrued = epochsElapsed * pool.emissionRatePerEpoch;
		pool.accRewardPerShare +=
			(rewardAccrued * ACC_REWARD_PRECISION) /
			pool.totalStaked;
		pool.lastUpdatedEpoch = epochNow;
	}

	function _pendingFromPosition(
		PoolState storage pool,
		UserPosition storage position
	) internal view returns (uint256) {
		if (position.amount == 0) return 0;
		return _rewardDebt(pool, position.amount) - position.rewardDebt;
	}

	function _rewardDebt(
		PoolState storage pool,
		uint256 amount
	) internal view returns (uint256) {
		return (amount * pool.accRewardPerShare) / ACC_REWARD_PRECISION;
	}
}
