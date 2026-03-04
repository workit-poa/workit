// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedPoint128} from "../../libraries/FixedPoint128.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../../libraries/utils.sol";

/**
 * @title Liquid Staked Token (LST) Abstract Contract
 * @dev This abstract contract represents a liquid staking token where:
 *      - The reward token (asset) is distinct from the staked token.
 *      - Stakers receive a 1:1 ratio of staked tokens to shares (represented by this contract's ERC20 tokens).
 *      - Rewards are distributed based on the Reward Per Share (RPS) model.
 *      - Designed to be upgradeable using OpenZeppelin's upgradeable contracts framework.
 */
abstract contract LST is Initializable, ERC20Upgradeable {
	using Math for uint256;

	/// @notice Thrown when attempting to set the asset more than once.
	/// @param asset The address of the asset that was already set.
	error AssetAlreadySet(IERC20 asset);

	/**
	 * @dev Storage structure for the LST contract.
	 * @custom:storage-location erc7201:workit.tokens.LST.storage
	 */
	struct LSTStore {
		IERC20 _asset;
		uint256 _rewardPerShare;
		uint256 _rewardReserve;
		mapping(address => uint256) _userRewardPerShare;
	}

	// keccak256(abi.encode(uint256(keccak256("workit.tokens.LST.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant LST_STORAGE_SLOT =
		0x3388a75e46c909e093e4b2825508aee7f02e81b135f1cb6377f3377ae3f73100;

	/**
	 * @dev Retrieves the LSTStore storage struct.
	 * @return $ Reference to the LSTStore storage.
	 */
	function _getLSTStorage() private pure returns (LSTStore storage $) {
		assembly {
			$.slot := LST_STORAGE_SLOT
		}
	}

	/**
	 * @dev Initializes the LST contract with the specified reward asset.
	 * @param asset_ The ERC20 token to be used as the reward asset.
	 */
	function __LST_init(IERC20 asset_) internal onlyInitializing {
		__LST_init_unchained(asset_);
	}

	/**
	 * @dev Unchained initialization logic for the LST contract.
	 * @param asset_ The ERC20 token to be used as the reward asset.
	 */
	function __LST_init_unchained(IERC20 asset_) internal onlyInitializing {
		_setAsset(asset_);
	}

	/**
	 * @dev Sets the reward asset for the contract.
	 *      Can only be called once; subsequent calls will revert.
	 * @param asset_ The ERC20 token to be set as the reward asset.
	 */
	function _setAsset(IERC20 asset_) internal {
		LSTStore storage $ = _getLSTStorage();
		if (address($._asset) != address(0)) {
			revert AssetAlreadySet($._asset);
		}

		$._asset = asset_;
	}

	/**
	 * @dev Computes the accumulated rewards and the increase in reward per share.
	 * @param $ Reference to the LSTStore storage.
	 * @return rewards The amount of new rewards accumulated.
	 * @return rpsIncrease The increase in reward per share.
	 */
	function _computeAccumulatedRewards(
		LSTStore storage $
	) internal view returns (uint256 rewards, uint256 rpsIncrease) {
		uint256 supply = totalSupply();

		if (supply == 0) return (0, 0);

		rewards = $._asset.balanceOf(address(this)) - $._rewardReserve;
		rpsIncrease = rewards.mulDiv(FixedPoint128.Q128, supply);
	}

	event RewardsUpdated(
		uint256 rewards,
		uint256 rpsIncrease,
		uint256 newRewardPerShare
	);

	/**
	 * @dev Updates the reward accounting by incorporating new rewards.
	 * @param $ Reference to the LSTStore storage.
	 * @return rewards The amount of new rewards added.
	 * @return rpsIncrease The increase in reward per share.
	 */
	function _updateRewards(
		LSTStore storage $
	) internal returns (uint256 rewards, uint256 rpsIncrease) {
		(rewards, rpsIncrease) = _computeAccumulatedRewards($);
		if (rewards > 0) {
			$._rewardReserve += rewards;
			$._rewardPerShare += rpsIncrease;

			emit RewardsUpdated(rewards, rpsIncrease, $._rewardPerShare);
		}
	}

	/// @notice Emitted when a user claims rewards.
	event RewardsClaimed(address indexed user, uint256 amount);

	/**
	 * @notice Allows a user to claim their accumulated reward tokens.
	 * @return claimed The amount of reward tokens claimed.
	 */
	function claimRewards() external returns (uint256) {
		return _claimReward(msg.sender);
	}

	/**
	 * @dev Internal function to claim rewards for a user.
	 * @param user The address of the user.
	 * @return claimed The amount of reward tokens claimed.
	 */
	function _claimReward(address user) internal returns (uint256 claimed) {
		LSTStore storage $ = _getLSTStorage();

		_updateRewards($);
		(uint256 shares, uint256 claimable) = _claimableReward(
			$,
			user,
			0 // rpsIncrease is set to 0 since `_updateRewards` has already accounted for it
		);

		if (claimable > 0) {
			_setUserRps($, address(0), user, shares, $._rewardPerShare);

			$._rewardReserve -= claimable;
			SafeERC20.safeTransfer($._asset, user, claimable);

			claimed = claimable;
			emit RewardsClaimed(user, claimed);
		}

		return claimed;
	}

	/**
	 * @dev Calculates the claimable reward for a user.
	 * @param $ Reference to the LSTStore storage.
	 * @param user The address of the user.
	 * @param rpsIncrease The increase in reward per share.
	 * @return userShares The number of shares the user holds.
	 * @return claimable The amount of claimable reward.
	 */
	function _claimableReward(
		LSTStore storage $,
		address user,
		uint256 rpsIncrease
	) private view returns (uint256 userShares, uint256 claimable) {
		userShares = balanceOf(user);

		uint256 _rewardPerShare = $._rewardPerShare + rpsIncrease;
		uint256 _userRewardPerShare = $._userRewardPerShare[user];

		claimable = userShares.mulDiv(
			_rewardPerShare - _userRewardPerShare,
			FixedPoint128.Q128
		);
	}

	/**
	 * @notice Retrieves the address of the reward asset.
	 * @return The address of the ERC20 reward asset.
	 */
	function asset() public view virtual returns (address) {
		LSTStore storage $ = _getLSTStorage();
		return address($._asset);
	}

	/**
	 * @notice Retrieves the total amount of reward assets held by the contract.
	 * @return The total balance of the reward asset in the contract.
	 */
	function totalAssets() public view virtual returns (uint256) {
		return IERC20(asset()).balanceOf(address(this));
	}

	/**
	 * @notice Retrieves the accumulated reward per share.
	 * @return The accumulated reward per share.
	 */
	function rewardPerShare() public view returns (uint256) {
		return _getLSTStorage()._rewardPerShare;
	}

	/**
	 * @notice Retrieves the reward debt of a user.
	 * @param user The address of the user.
	 * @return The reward debt of the user.
	 */
	function userRewardPerShare(address user) public view returns (uint256) {
		return _getLSTStorage()._userRewardPerShare[user];
	}

	/**
	 * @notice Calculates the claimable reward for a user.
	 * @param user The address of the user.
	 * @return The amount of claimable reward.
	 */
	function claimableReward(address user) public view returns (uint256) {
		LSTStore storage $ = _getLSTStorage();

		(, uint256 rpsIncrease) = _computeAccumulatedRewards($);
		(, uint256 claimable) = _claimableReward($, user, rpsIncrease);

		return claimable;
	}

	event UserRewardPerShareUpdate(
		address indexed from,
		address indexed to,
		uint256 shares,
		uint256 rps,
		uint256 globalRps
	);

	function _setUserRps(
		LSTStore storage $,
		address from,
		address to,
		uint256 shares,
		uint256 rps
	) private {
		$._userRewardPerShare[to] = rps;
		emit UserRewardPerShareUpdate(from, to, shares, rps, $._rewardPerShare);
	}

	/**
	 * @dev Overrides the ERC20 _update function to include reward debt updates.
	 * @param from The address tokens are transferred from.
	 * @param to The address tokens are transferred to.
	 * @param value The amount of tokens transferred.
	 */
	function _update(
		address from,
		address to,
		uint256 value
	) internal virtual override {
		LSTStore storage $ = _getLSTStorage();
		_updateRewards($);

		if (to != address(0) && value > 0) {
			uint256 prevailingRps = from == address(0)
				? $._rewardPerShare
				: $._userRewardPerShare[from];
			uint256 sharesOfTo = balanceOf(to);

			_setUserRps(
				$,
				from,
				to,
				sharesOfTo,
				weightedAverageRoundUp(
					$._userRewardPerShare[to],
					sharesOfTo,
					prevailingRps,
					value
				)
			);
		}

		super._update(from, to, value);
	}
}
