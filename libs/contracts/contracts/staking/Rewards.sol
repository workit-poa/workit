// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {FixedPoint128} from "../libraries/FixedPoint128.sol";
import {FullMath} from "../uniswap-v2/libraries/FullMath.sol";
import {Epochs} from "../libraries/Epochs.sol";

import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";
import {IUniswapV2Factory} from "../uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {IGToken} from "../tokens/GToken/IGToken.sol";
import {IdHBAR} from "../tokens/dHBAR/IdHBAR.sol";
import {IWorkit} from "../tokens/Workit/IWorkit.sol";

import {IRewards} from "./IRewards.sol";

contract Rewards is IRewards, Initializable {
	using Epochs for Epochs.Storage;

	/*//////////////////////////////////////////////////////////////
	                               STORAGE
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:workitswap.staking.rewards.storage
	struct RewardsStorage {
		uint256 rewardPerShare; // Q128
		uint256 rewardsReserve; // Workit balance tracked
		address workit;
		address gToken;
		address router;
	}
	bytes32 internal constant REWARDS_STORAGE_LOCATION =
		keccak256("workitswap.staking.rewards.storage") &
			~bytes32(uint256(0xff));

	function _rewardsStorage() private pure returns (RewardsStorage storage $) {
		bytes32 slot = REWARDS_STORAGE_LOCATION;
		assembly {
			$.slot := slot
		}
	}

	/*//////////////////////////////////////////////////////////////
	                             INITIALIZATION
	//////////////////////////////////////////////////////////////*/

	function initialize(
		address _workit,
		address _gToken,
		address _router
	) external initializer {
		require(_workit != address(0), "Rewards: workit = zero");
		require(_gToken != address(0), "Rewards: gToken = zero");
		require(_router != address(0), "Rewards: router = zero");

		RewardsStorage storage $ = _rewardsStorage();

		$.workit = _workit;
		$.gToken = _gToken;
		$.router = _router;

		emit RewardsInitialized(_workit, _gToken, _router);
	}

	/*//////////////////////////////////////////////////////////////
	                          INTERNAL COMPUTATION
	//////////////////////////////////////////////////////////////*/

	function _computeAccumulated(
		uint256 totalReward,
		uint256 totalStakeWeight,
		IdHBAR dhbar
	) internal view returns (uint256 accumulatedReward, uint256 rpsDelta) {
		if (totalStakeWeight == 0) return (0, 0);

		RewardsStorage storage $ = _rewardsStorage();

		uint256 dHBARSupply = dhbar.totalSupply();
		uint256 gTokenSupply = IGToken($.gToken).totalSupply();
		uint256 aggregateSupply = dHBARSupply + gTokenSupply;

		accumulatedReward = (gTokenSupply * totalReward) / aggregateSupply;
		rpsDelta = FullMath.mulDiv(
			accumulatedReward,
			FixedPoint128.Q128,
			totalStakeWeight
		);
	}

	function _computeClaimable(
		address user,
		uint256[] memory nonces,
		address _gToken,
		uint256 rps
	)
		internal
		view
		returns (uint256 claimable, IGToken.Attributes[] memory attributes)
	{
		RewardsStorage storage $ = _rewardsStorage();
		IUniswapV2Factory factory = IUniswapV2Factory(
			IUniswapV2Router($.router).factory()
		);

		attributes = new IGToken.Attributes[](nonces.length);

		for (uint256 i = 0; i < nonces.length; i++) {
			attributes[i] = IGToken(_gToken)
				.getBalanceAt(user, nonces[i])
				.attributes;

			address token0 = attributes[i].lpDetails.token0;
			address token1 = attributes[i].lpDetails.token1;
			if (factory.getPair(token0, token1) == address(0)) {
				revert PairNotFound(token0, token1);
			}

			uint256 tokenRPS = attributes[i].rewardPerShare;
			if (rps >= tokenRPS) {
				uint256 rpsDiff = rps - tokenRPS;

				claimable += FullMath.mulDiv(
					attributes[i].stakeWeight,
					rpsDiff,
					FixedPoint128.Q128
				);
			}
		}
	}

	/*//////////////////////////////////////////////////////////////
	                          REWARD ACCOUNTING
	//////////////////////////////////////////////////////////////*/

	function updateRewardReserve() external {
		RewardsStorage storage $ = _rewardsStorage();

		uint256 balance = IERC20($.workit).balanceOf(address(this));
		uint256 totalAdded = balance - $.rewardsReserve;
		if (totalAdded == 0) return;

		address dhbar = IUniswapV2Router($.router).dHBAR();
		uint256 totalStakeWeight = IGToken($.gToken).totalStakeWeight();
		if (totalStakeWeight == 0) {
			IERC20($.workit).transfer(dhbar, totalAdded);

			emit RewardsRedirectedToDHBAR(totalAdded);
			return;
		}

		(uint256 holdersShare, uint256 rps) = _computeAccumulated(
			totalAdded,
			totalStakeWeight,
			IdHBAR(dhbar)
		);

		$.rewardsReserve += holdersShare;
		$.rewardPerShare += rps;

		uint256 dHBARShare = totalAdded - holdersShare;
		IERC20($.workit).transfer(dhbar, dHBARShare);

		emit RewardsUpdated(
			totalAdded,
			holdersShare,
			dHBARShare,
			$.rewardPerShare
		);
	}

	/*//////////////////////////////////////////////////////////////
	                           USER ACTIONS
	//////////////////////////////////////////////////////////////*/

	function claimRewards(uint256[] memory nonces, address to) external {
		RewardsStorage storage $ = _rewardsStorage();

		IWorkit($.workit).mintWorkit();
		uint256 currentEpoch = IWorkit($.workit).epochs().currentEpoch();

		address user = msg.sender;
		(
			uint256 claimable,
			IGToken.Attributes[] memory attributes
		) = _computeClaimable(user, nonces, $.gToken, $.rewardPerShare);

		if (claimable == 0) return;

		// Looks like this will never revert since rewards are minted
		require($.rewardsReserve >= claimable, "Rewards not enough");

		for (uint256 i = 0; i < nonces.length; i++) {
			IGToken.Attributes memory attribute = attributes[i];

			attribute.rewardPerShare = $.rewardPerShare;
			attribute.lastClaimEpoch = currentEpoch;

			IGToken($.gToken).update(user, nonces[i], attribute);
		}

		$.rewardsReserve -= claimable;
		IERC20($.workit).transfer(to, claimable);

		emit RewardsClaimed(
			user,
			to,
			currentEpoch,
			block.timestamp,
			claimable,
			$.rewardPerShare
		);
	}

	/*//////////////////////////////////////////////////////////////
	                               VIEWS
	//////////////////////////////////////////////////////////////*/

	function claimableFor(
		address user,
		uint256[] calldata nonces
	) external view returns (uint256 claimable) {
		RewardsStorage storage $ = _rewardsStorage();

		(, uint256 rpsToAdd) = _computeAccumulated(
			IWorkit($.workit).stakersWorkitToEmit(),
			IGToken($.gToken).totalStakeWeight(),
			IdHBAR(IUniswapV2Router($.router).dHBAR())
		);

		(claimable, ) = _computeClaimable(
			user,
			nonces,
			$.gToken,
			$.rewardPerShare + rpsToAdd
		);
	}

	function rewardPerShare() public view returns (uint256) {
		return _rewardsStorage().rewardPerShare;
	}

	function workit() external view returns (address) {
		return _rewardsStorage().workit;
	}

	function gToken() external view returns (address) {
		return _rewardsStorage().gToken;
	}
}
