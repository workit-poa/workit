// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {EmissionsManager} from "./EmissionsManager.sol";
import {WorkitGToken} from "./WorkitGToken.sol";

/// @title WorkitStaking
/// @notice Staking vault for pool-specific GToken liquidity receipts.
contract WorkitStaking is AccessControl, ERC1155Holder, ReentrancyGuard {
	using EnumerableSet for EnumerableSet.UintSet;

	bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

	WorkitGToken public immutable gToken;
	EmissionsManager public emissionsManager;

	mapping(uint256 => uint256) public totalPoolStake;
	mapping(address => mapping(uint256 => uint256)) public userPoolStake;
	mapping(address => EnumerableSet.UintSet) private _userPools;

	error ZeroAddress();
	error ZeroAmount();
	error InsufficientStake(uint256 requested, uint256 available);

	event Staked(address indexed user, uint256 indexed poolId, uint256 amount);
	event Unstaked(address indexed user, uint256 indexed poolId, uint256 amount);
	event RewardsClaimed(address indexed user, address indexed to, uint256 amount);
	event EmissionsManagerUpdated(address indexed emissionsManager);

	constructor(address admin, WorkitGToken gToken_) {
		if (admin == address(0) || address(gToken_) == address(0)) {
			revert ZeroAddress();
		}

		gToken = gToken_;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(OPERATOR_ROLE, admin);
	}

	/// @notice Sets emissions manager used for reward accounting.
	function setEmissionsManager(
		EmissionsManager manager
	) external onlyRole(OPERATOR_ROLE) {
		if (address(manager) == address(0)) revert ZeroAddress();
		emissionsManager = manager;
		emit EmissionsManagerUpdated(address(manager));
	}

	/// @notice Stake pool-specific GToken receipts.
	function stake(uint256 poolId, uint256 amount) external nonReentrant {
		if (amount == 0) revert ZeroAmount();

		gToken.safeTransferFrom(msg.sender, address(this), poolId, amount, "");

		userPoolStake[msg.sender][poolId] += amount;
		totalPoolStake[poolId] += amount;
		_userPools[msg.sender].add(poolId);

		if (address(emissionsManager) != address(0)) {
			emissionsManager.onStake(poolId, msg.sender, amount);
		}

		emit Staked(msg.sender, poolId, amount);
	}

	/// @notice Unstake pool-specific GToken receipts.
	function unstake(uint256 poolId, uint256 amount) external nonReentrant {
		if (amount == 0) revert ZeroAmount();

		uint256 currentStake = userPoolStake[msg.sender][poolId];
		if (amount > currentStake) revert InsufficientStake(amount, currentStake);

		userPoolStake[msg.sender][poolId] = currentStake - amount;
		totalPoolStake[poolId] -= amount;

		if (userPoolStake[msg.sender][poolId] == 0) {
			_userPools[msg.sender].remove(poolId);
		}

		if (address(emissionsManager) != address(0)) {
			emissionsManager.onUnstake(poolId, msg.sender, amount);
		}

		gToken.safeTransferFrom(address(this), msg.sender, poolId, amount, "");
		emit Unstaked(msg.sender, poolId, amount);
	}

	/// @notice Claims rewards from all pools the user currently has stake in.
	function claimRewards(address to) external nonReentrant returns (uint256 totalClaimed) {
		if (to == address(0)) revert ZeroAddress();
		if (address(emissionsManager) == address(0)) return 0;

		EnumerableSet.UintSet storage pools = _userPools[msg.sender];
		uint256 length = pools.length();
		for (uint256 i = 0; i < length; i++) {
			totalClaimed += emissionsManager.claimFor(pools.at(i), msg.sender, to);
		}

		emit RewardsClaimed(msg.sender, to, totalClaimed);
	}

	/// @notice Claims rewards for a single pool.
	function claimRewardsForPool(
		uint256 poolId,
		address to
	) external nonReentrant returns (uint256 claimed) {
		if (to == address(0)) revert ZeroAddress();
		if (address(emissionsManager) == address(0)) return 0;

		claimed = emissionsManager.claimFor(poolId, msg.sender, to);
		emit RewardsClaimed(msg.sender, to, claimed);
	}

	/// @notice Returns currently staked pools for a user.
	function stakedPools(address user) external view returns (uint256[] memory) {
		return _userPools[user].values();
	}

	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		virtual
		override(AccessControl, ERC1155Holder)
		returns (bool)
	{
		return super.supportsInterface(interfaceId);
	}
}
