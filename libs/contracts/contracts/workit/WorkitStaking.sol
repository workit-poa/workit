// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {FullMath} from "../gainzswap/uniswap-v2/libraries/FullMath.sol";
import {FixedPoint128} from "../gainzswap/libraries/FixedPoint128.sol";

import {IWorkitGToken} from "./interfaces/IWorkitGToken.sol";
import {IWorkitStaking} from "./interfaces/IWorkitStaking.sol";
import {IWorkitEmissionManager} from "./interfaces/IWorkitEmissionManager.sol";

contract WorkitStaking is
	AccessControl,
	ReentrancyGuard,
	ERC1155Holder,
	IWorkitStaking
{
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.UintSet;

	uint256 public constant WEIGHT_SCALE = 1e18;

	bytes32 public constant POOL_MANAGER_ROLE = keccak256("POOL_MANAGER_ROLE");

	struct PoolInfo {
		uint256 totalStaked;
		uint256 emissionWeight;
		uint256 accRewardPerShareX128;
		bool enabled;
	}

	IERC20 public immutable workit;
	IWorkitGToken public immutable gToken;

	IWorkitEmissionManager public emissionManager;
	address public treasury;

	uint256 public rewardReserve;
	uint256 public totalWeightedStake;

	EnumerableSet.UintSet private _activeTokenIds;

	mapping(uint256 => PoolInfo) public pools;
	mapping(address => mapping(uint256 => uint256)) public userAmount;
	mapping(address => mapping(uint256 => uint256)) public userRewardDebt;
	mapping(address => uint256) public pendingRewards;

	event EmissionManagerUpdated(
		address indexed previousEmissionManager,
		address indexed emissionManager
	);
	event TreasuryUpdated(address indexed previousTreasury, address indexed treasury);
	event PoolEnabled(address indexed pool, uint256 indexed tokenId, uint256 weight);
	event PoolEmissionWeightSet(
		address indexed pool,
		uint256 indexed tokenId,
		uint256 previousWeight,
		uint256 newWeight
	);
	event Staked(
		address indexed user,
		address indexed pool,
		uint256 indexed tokenId,
		uint256 amount
	);
	event Withdrawn(
		address indexed user,
		address indexed pool,
		uint256 indexed tokenId,
		uint256 amount
	);
	event RewardsUpdated(
		uint256 totalAdded,
		uint256 retainedForStakers,
		uint256 rewardReserve
	);
	event RewardsRedirected(uint256 amount, address indexed treasury);
	event RewardsClaimed(address indexed user, address indexed to, uint256 amount);

	error ZeroAddress();
	error InvalidAmount();
	error InvalidListingPool(address pool, uint256 tokenId);
	error PoolNotEnabled(address pool, uint256 tokenId);
	error InsufficientStakedBalance(uint256 requested, uint256 available);
	error NoRewards();

	constructor(
		address admin,
		address workit_,
		address gToken_,
		address emissionManager_,
		address treasury_
	) {
		if (
			admin == address(0) ||
			workit_ == address(0) ||
			gToken_ == address(0) ||
			treasury_ == address(0)
		) {
			revert ZeroAddress();
		}

		workit = IERC20(workit_);
		gToken = IWorkitGToken(gToken_);
		emissionManager = IWorkitEmissionManager(emissionManager_);
		treasury = treasury_;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(POOL_MANAGER_ROLE, admin);
	}

	function setEmissionManager(
		address emissionManager_
	) external onlyRole(DEFAULT_ADMIN_ROLE) {
		address previousEmissionManager = address(emissionManager);
		emissionManager = IWorkitEmissionManager(emissionManager_);

		emit EmissionManagerUpdated(previousEmissionManager, emissionManager_);
	}

	function setTreasury(address treasury_) external onlyRole(POOL_MANAGER_ROLE) {
		if (treasury_ == address(0)) revert ZeroAddress();

		address previousTreasury = treasury;
		treasury = treasury_;

		emit TreasuryUpdated(previousTreasury, treasury_);
	}

	function enableListingPool(address pool) external override onlyRole(POOL_MANAGER_ROLE) {
		(address listingPool, uint256 tokenId) = _validateListingPool(pool);
		PoolInfo storage poolInfo = pools[tokenId];
		if (poolInfo.emissionWeight == 0) {
			poolInfo.emissionWeight = WEIGHT_SCALE;
		}
		poolInfo.enabled = true;
		_activeTokenIds.add(tokenId);

		emit PoolEnabled(listingPool, tokenId, poolInfo.emissionWeight);
	}

	function setPoolEmissionWeight(
		address pool,
		uint256 newWeight
	) external override onlyRole(POOL_MANAGER_ROLE) nonReentrant {
		(address listingPool, uint256 tokenId) = _validateListingPool(pool);
		_syncEmissionAndRewards();

		PoolInfo storage poolInfo = pools[tokenId];
		if (!poolInfo.enabled) revert PoolNotEnabled(listingPool, tokenId);

		uint256 previousWeight = poolInfo.emissionWeight;
		if (previousWeight == newWeight) return;

		if (poolInfo.totalStaked > 0) {
			uint256 previousWeighted = _weightedStake(
				poolInfo.totalStaked,
				previousWeight
			);
			uint256 newWeighted = _weightedStake(poolInfo.totalStaked, newWeight);
			totalWeightedStake = totalWeightedStake - previousWeighted + newWeighted;
		}

		poolInfo.emissionWeight = newWeight;
		emit PoolEmissionWeightSet(listingPool, tokenId, previousWeight, newWeight);
	}

	function stake(uint256 tokenId, uint256 amount) external nonReentrant {
		if (amount == 0) revert InvalidAmount();

		_syncEmissionAndRewards();

		address pool = _validateListingTokenId(tokenId);
		PoolInfo storage poolInfo = pools[tokenId];
		if (!poolInfo.enabled) revert PoolNotEnabled(pool, tokenId);
		if (poolInfo.emissionWeight == 0) revert PoolNotEnabled(pool, tokenId);

		_accrueUser(msg.sender, tokenId);

		gToken.safeTransferFrom(msg.sender, address(this), tokenId, amount, "");

		userAmount[msg.sender][tokenId] += amount;
		poolInfo.totalStaked += amount;
		totalWeightedStake += _weightedStake(amount, poolInfo.emissionWeight);

		_refreshUserDebt(msg.sender, tokenId);

		emit Staked(msg.sender, pool, tokenId, amount);
	}

	function withdraw(
		uint256 tokenId,
		uint256 amount,
		address to
	) external nonReentrant {
		if (amount == 0) revert InvalidAmount();
		if (to == address(0)) revert ZeroAddress();

		_syncEmissionAndRewards();

		address pool = _validateListingTokenId(tokenId);
		PoolInfo storage poolInfo = pools[tokenId];
		if (!poolInfo.enabled) revert PoolNotEnabled(pool, tokenId);

		_accrueUser(msg.sender, tokenId);

		uint256 userStaked = userAmount[msg.sender][tokenId];
		if (amount > userStaked) {
			revert InsufficientStakedBalance(amount, userStaked);
		}

		userAmount[msg.sender][tokenId] = userStaked - amount;
		poolInfo.totalStaked -= amount;
		totalWeightedStake -= _weightedStake(amount, poolInfo.emissionWeight);

		_refreshUserDebt(msg.sender, tokenId);

		gToken.safeTransferFrom(address(this), to, tokenId, amount, "");

		emit Withdrawn(msg.sender, pool, tokenId, amount);
	}

	function claimRewards(
		uint256[] calldata tokenIds,
		address to
	) external nonReentrant returns (uint256 claimed) {
		if (to == address(0)) revert ZeroAddress();
		if (tokenIds.length == 0) revert InvalidAmount();

		_syncEmissionAndRewards();

		for (uint256 i; i < tokenIds.length; ++i) {
			_validateListingTokenId(tokenIds[i]);
			_accrueUser(msg.sender, tokenIds[i]);
		}

		claimed = pendingRewards[msg.sender];
		if (claimed == 0) revert NoRewards();

		pendingRewards[msg.sender] = 0;
		rewardReserve -= claimed;
		workit.safeTransfer(to, claimed);

		emit RewardsClaimed(msg.sender, to, claimed);
	}

	function updateRewardReserve() external override nonReentrant {
		_syncEmissionAndRewards();
	}

	function claimableFor(
		address user,
		uint256[] calldata tokenIds
	) external view returns (uint256 claimable) {
		claimable = pendingRewards[user];

		uint256 unaccountedRewards = _unaccountedRewards();
		if (unaccountedRewards > 0 && totalWeightedStake > 0) {
			unaccountedRewards += _pendingEmissionPreview();
		}

		for (uint256 i; i < tokenIds.length; ++i) {
			uint256 tokenId = tokenIds[i];
			uint256 amount = userAmount[user][tokenId];
			if (amount == 0) continue;

			PoolInfo storage poolInfo = pools[tokenId];
			uint256 virtualAcc = poolInfo.accRewardPerShareX128;

			if (
				unaccountedRewards > 0 &&
				totalWeightedStake > 0 &&
				poolInfo.totalStaked > 0 &&
				poolInfo.emissionWeight > 0
			) {
				uint256 poolWeighted = _weightedStake(
					poolInfo.totalStaked,
					poolInfo.emissionWeight
				);
				uint256 poolAllocation = FullMath.mulDiv(
					unaccountedRewards,
					poolWeighted,
					totalWeightedStake
				);
				virtualAcc += FullMath.mulDiv(
					poolAllocation,
					FixedPoint128.Q128,
					poolInfo.totalStaked
				);
			}

			uint256 accumulated = FullMath.mulDiv(
				amount,
				virtualAcc,
				FixedPoint128.Q128
			);
			uint256 debt = userRewardDebt[user][tokenId];
			if (accumulated > debt) {
				claimable += accumulated - debt;
			}
		}
	}

	function activePoolTokenIds() external view returns (uint256[] memory ids) {
		return _activeTokenIds.values();
	}

	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		override(AccessControl, ERC1155Holder)
		returns (bool)
	{
		return super.supportsInterface(interfaceId);
	}

	function _syncEmissionAndRewards() internal {
		if (address(emissionManager) != address(0)) {
			emissionManager.mintForStaking();
		}
		_distributeNewRewards();
	}

	function _distributeNewRewards() internal {
		uint256 unaccounted = _unaccountedRewards();
		if (unaccounted == 0) return;

		if (totalWeightedStake == 0) {
			workit.safeTransfer(treasury, unaccounted);
			emit RewardsRedirected(unaccounted, treasury);
			return;
		}

		uint256 remainingRewards = unaccounted;
		uint256 remainingWeight = totalWeightedStake;
		uint256 retainedForStakers;

		uint256 len = _activeTokenIds.length();
		for (uint256 i; i < len; ++i) {
			uint256 tokenId = _activeTokenIds.at(i);
			PoolInfo storage poolInfo = pools[tokenId];
			if (
				!poolInfo.enabled ||
				poolInfo.totalStaked == 0 ||
				poolInfo.emissionWeight == 0
			) {
				continue;
			}

			uint256 poolWeighted = _weightedStake(
				poolInfo.totalStaked,
				poolInfo.emissionWeight
			);
			if (poolWeighted == 0) continue;

			uint256 allocation = poolWeighted >= remainingWeight
				? remainingRewards
				: FullMath.mulDiv(remainingRewards, poolWeighted, remainingWeight);
			if (allocation == 0) continue;

			poolInfo.accRewardPerShareX128 += FullMath.mulDiv(
				allocation,
				FixedPoint128.Q128,
				poolInfo.totalStaked
			);

			retainedForStakers += allocation;
			remainingRewards -= allocation;
			remainingWeight -= poolWeighted;

			if (remainingRewards == 0 || remainingWeight == 0) break;
		}

		if (remainingRewards > 0) {
			workit.safeTransfer(treasury, remainingRewards);
			emit RewardsRedirected(remainingRewards, treasury);
		}

		rewardReserve += retainedForStakers;
		emit RewardsUpdated(unaccounted, retainedForStakers, rewardReserve);
	}

	function _accrueUser(address user, uint256 tokenId) internal {
		uint256 amount = userAmount[user][tokenId];
		if (amount == 0) {
			userRewardDebt[user][tokenId] = 0;
			return;
		}

		PoolInfo storage poolInfo = pools[tokenId];
		uint256 accumulated = FullMath.mulDiv(
			amount,
			poolInfo.accRewardPerShareX128,
			FixedPoint128.Q128
		);
		uint256 debt = userRewardDebt[user][tokenId];
		if (accumulated > debt) {
			pendingRewards[user] += accumulated - debt;
		}
		userRewardDebt[user][tokenId] = accumulated;
	}

	function _refreshUserDebt(address user, uint256 tokenId) internal {
		uint256 amount = userAmount[user][tokenId];
		if (amount == 0) {
			userRewardDebt[user][tokenId] = 0;
			return;
		}

		userRewardDebt[user][tokenId] = FullMath.mulDiv(
			amount,
			pools[tokenId].accRewardPerShareX128,
			FixedPoint128.Q128
		);
	}

	function _validateListingPool(
		address pool
	) internal view returns (address listingPool, uint256 tokenId) {
		listingPool = pool;
		tokenId = gToken.tokenIdForPool(listingPool);
		if (
			listingPool == address(0) ||
			tokenId == 0 ||
			!gToken.isListingPool(listingPool) ||
			gToken.deriveTokenId(listingPool) != tokenId
		) {
			revert InvalidListingPool(listingPool, tokenId);
		}
	}

	function _validateListingTokenId(
		uint256 tokenId
	) internal view returns (address pool) {
		pool = gToken.poolForToken(tokenId);
		if (
			pool == address(0) ||
			!gToken.isListingPool(pool) ||
			gToken.tokenIdForPool(pool) != tokenId ||
			gToken.deriveTokenId(pool) != tokenId
		) {
			revert InvalidListingPool(pool, tokenId);
		}
	}

	function _weightedStake(
		uint256 amount,
		uint256 emissionWeight
	) internal pure returns (uint256) {
		return FullMath.mulDiv(amount, emissionWeight, WEIGHT_SCALE);
	}

	function _unaccountedRewards() internal view returns (uint256) {
		uint256 balance = workit.balanceOf(address(this));
		if (balance <= rewardReserve) return 0;
		return balance - rewardReserve;
	}

	function _pendingEmissionPreview() internal view returns (uint256) {
		if (address(emissionManager) == address(0)) return 0;
		try emissionManager.pendingStakingEmission() returns (uint256 pending) {
			return pending;
		} catch {
			return 0;
		}
	}
}
