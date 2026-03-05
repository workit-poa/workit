// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {FixedPoint128} from "../libraries/FixedPoint128.sol";
import {FullMath} from "../libraries/FullMath.sol";

import {IGToken} from "../tokens/GToken/IGToken.sol";

import {IRewards} from "./IRewards.sol";

interface IWorkEmissionController {
	function currentEpoch() external view returns (uint256);

	function stakersWorkToEmit() external view returns (uint256);
}

contract Rewards is IRewards, Initializable {
	/*//////////////////////////////////////////////////////////////
	                               STORAGE
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:workit.contracts.staking.Rewards
	struct RewardsStorage {
		uint256 rewardPerShare; // Q128
		uint256 rewardsReserve;
		address workToken;
		address gToken;
		address workEmissionController;
	}

	// keccak256("workit.contracts.staking.Rewards") & ~bytes32(uint256(0xff))
	bytes32 internal constant REWARDS_STORAGE_LOCATION =
		0xe119c2c6d8b5b8e144ebd8495e8641bf27af41382742e314fc80c280b35b6600;

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
		address _workToken,
		address _gToken,
		address _workEmissionController
	) external initializer {
		require(_workToken != address(0), "Rewards: work token = zero");
		require(_gToken != address(0), "Rewards: gToken = zero");
		require(
			_workEmissionController != address(0),
			"Rewards: controller = zero"
		);

		RewardsStorage storage $ = _rewardsStorage();
		$.workToken = _workToken;
		$.gToken = _gToken;
		$.workEmissionController = _workEmissionController;

		emit RewardsInitialized(_workToken, _gToken);
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
		RewardsStorage storage $ = _rewardsStorage();
		attributes = new IGToken.Attributes[](nonces.length);

		for (uint256 i = 0; i < nonces.length; i++) {
			attributes[i] = IGToken($.gToken).getBalanceAt(user, nonces[i]).attributes;

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
		RewardsStorage storage $ = _rewardsStorage();

		uint256 balance = IERC20($.workToken).balanceOf(address(this));
		if (balance <= $.rewardsReserve) return;

		uint256 totalAdded = balance - $.rewardsReserve;
		uint256 totalStakeWeight = IGToken($.gToken).totalStakeWeight();
		if (totalStakeWeight == 0) {
			return;
		}

		uint256 rpsDelta = _computeAccumulated(totalAdded, totalStakeWeight);

		$.rewardsReserve += totalAdded;
		$.rewardPerShare += rpsDelta;

		emit RewardsUpdated(totalAdded, $.rewardPerShare);
	}

	/*//////////////////////////////////////////////////////////////
	                           USER ACTIONS
	//////////////////////////////////////////////////////////////*/

	function claimRewards(uint256[] memory nonces, address to) external {
		require(to != address(0), "Rewards: to = zero");

		RewardsStorage storage $ = _rewardsStorage();
		address user = msg.sender;

		uint256 currentEpoch = IWorkEmissionController($.workEmissionController)
			.currentEpoch();

		(
			uint256 claimable,
			IGToken.Attributes[] memory attributes
		) = _computeClaimable(user, nonces, $.rewardPerShare);

		if (claimable == 0) return;
		require($.rewardsReserve >= claimable, "Rewards: reserve too low");

		for (uint256 i = 0; i < nonces.length; i++) {
			IGToken.Attributes memory attribute = attributes[i];
			attribute.rewardPerShare = $.rewardPerShare;
			attribute.lastClaimEpoch = currentEpoch;

			IGToken($.gToken).update(user, nonces[i], attribute);
		}

		$.rewardsReserve -= claimable;
		require(IERC20($.workToken).transfer(to, claimable), "Rewards: transfer failed");

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

		uint256 rpsToAdd = _computeAccumulated(
			IWorkEmissionController($.workEmissionController).stakersWorkToEmit(),
			IGToken($.gToken).totalStakeWeight()
		);

		(claimable, ) = _computeClaimable(
			user,
			nonces,
			$.rewardPerShare + rpsToAdd
		);
	}

	function rewardPerShare() public view returns (uint256) {
		return _rewardsStorage().rewardPerShare;
	}

	function rewardsReserve() external view returns (uint256) {
		return _rewardsStorage().rewardsReserve;
	}

	function workToken() external view returns (address) {
		return _rewardsStorage().workToken;
	}

	function gToken() external view returns (address) {
		return _rewardsStorage().gToken;
	}

	function workEmissionController() external view returns (address) {
		return _rewardsStorage().workEmissionController;
	}
}
