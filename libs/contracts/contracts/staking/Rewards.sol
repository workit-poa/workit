// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {FixedPoint128} from "../libraries/FixedPoint128.sol";
import {FullMath} from "../libraries/FullMath.sol";

import {IGToken} from "../tokens/GToken/IGToken.sol";

import {IRewards} from "./IRewards.sol";

interface IWorkEmissionController {
	function currentEpoch() external view returns (uint256);

	function stakersWorkToEmit() external view returns (uint256);
}

contract Rewards is IRewards {
	uint256 public override rewardPerShare; // Q128
	uint256 public rewardsReserve;
	address public workToken;
	address public gToken;
	address public workEmissionController;

	constructor(
		address workToken_,
		address gToken_,
		address workEmissionController_
	) {
		require(workToken_ != address(0), "Rewards: work token = zero");
		require(gToken_ != address(0), "Rewards: gToken = zero");
		require(
			workEmissionController_ != address(0),
			"Rewards: controller = zero"
		);

		workToken = workToken_;
		gToken = gToken_;
		workEmissionController = workEmissionController_;

		emit RewardsInitialized(workToken_, gToken_);
	}

	/*//////////////////////////////////////////////////////////////
	                          INTERNAL COMPUTATION
	//////////////////////////////////////////////////////////////*/

	function _computeAccumulated(
		uint256 totalReward,
		uint256 totalStakeWeight
	) internal pure returns (uint256 rpsDelta) {
		if (totalStakeWeight == 0) return 0;

		rpsDelta = FullMath.mulDiv(
			totalReward,
			FixedPoint128.Q128,
			totalStakeWeight
		);
	}

	function _computeClaimable(
		address user,
		uint256[] memory nonces,
		uint256 rps
	)
		internal
		view
		returns (uint256 claimable, IGToken.Attributes[] memory attributes)
	{
		attributes = new IGToken.Attributes[](nonces.length);

		for (uint256 i = 0; i < nonces.length; i++) {
			attributes[i] = IGToken(gToken).getBalanceAt(user, nonces[i]).attributes;

			uint256 tokenRps = attributes[i].rewardPerShare;
			if (rps >= tokenRps) {
				uint256 rpsDiff = rps - tokenRps;
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
		uint256 balance = IERC20(workToken).balanceOf(address(this));
		if (balance <= rewardsReserve) return;

		uint256 totalAdded = balance - rewardsReserve;
		uint256 totalStakeWeight = IGToken(gToken).totalStakeWeight();
		if (totalStakeWeight == 0) {
			return;
		}

		uint256 rpsDelta = _computeAccumulated(totalAdded, totalStakeWeight);

		rewardsReserve += totalAdded;
		rewardPerShare += rpsDelta;

		emit RewardsUpdated(totalAdded, rewardPerShare);
	}

	/*//////////////////////////////////////////////////////////////
	                           USER ACTIONS
	//////////////////////////////////////////////////////////////*/

	function claimRewards(uint256[] memory nonces, address to) external {
		require(to != address(0), "Rewards: to = zero");

		address user = msg.sender;

		uint256 currentEpoch = IWorkEmissionController(workEmissionController)
			.currentEpoch();

		(
			uint256 claimable,
			IGToken.Attributes[] memory attributes
		) = _computeClaimable(user, nonces, rewardPerShare);

		if (claimable == 0) return;
		require(rewardsReserve >= claimable, "Rewards: reserve too low");

		for (uint256 i = 0; i < nonces.length; i++) {
			IGToken.Attributes memory attribute = attributes[i];
			attribute.rewardPerShare = rewardPerShare;
			attribute.lastClaimEpoch = currentEpoch;

			IGToken(gToken).update(user, nonces[i], attribute);
		}

		rewardsReserve -= claimable;
		require(IERC20(workToken).transfer(to, claimable), "Rewards: transfer failed");

		emit RewardsClaimed(
			user,
			to,
			currentEpoch,
			block.timestamp,
			claimable,
			rewardPerShare
		);
	}

	/*//////////////////////////////////////////////////////////////
	                               VIEWS
	//////////////////////////////////////////////////////////////*/

	function claimableFor(
		address user,
		uint256[] calldata nonces
	) external view returns (uint256 claimable) {
		uint256 rpsToAdd = _computeAccumulated(
			IWorkEmissionController(workEmissionController).stakersWorkToEmit(),
			IGToken(gToken).totalStakeWeight()
		);

		(claimable, ) = _computeClaimable(
			user,
			nonces,
			rewardPerShare + rpsToAdd
		);
	}
}
