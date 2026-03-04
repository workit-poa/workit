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
import {IdEDU} from "../tokens/dEDU/IdEDU.sol";
import {IGainz} from "../tokens/Gainz/IGainz.sol";

import {IRewards} from "./IRewards.sol";

contract Rewards is IRewards, Initializable {
	using Epochs for Epochs.Storage;

	/*//////////////////////////////////////////////////////////////
	                               STORAGE
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:gainzswap.staking.rewards.storage
	struct RewardsStorage {
		uint256 rewardPerShare; // Q128
		uint256 rewardsReserve; // Gainz balance tracked
		address gainz;
		address gToken;
		address router;
	}
	bytes32 internal constant REWARDS_STORAGE_LOCATION =
		keccak256("gainzswap.staking.rewards.storage") &
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
		address _gainz,
		address _gToken,
		address _router
	) external initializer {
		require(_gainz != address(0), "Rewards: gainz = zero");
		require(_gToken != address(0), "Rewards: gToken = zero");
		require(_router != address(0), "Rewards: router = zero");

		RewardsStorage storage $ = _rewardsStorage();

		$.gainz = _gainz;
		$.gToken = _gToken;
		$.router = _router;

		emit RewardsInitialized(_gainz, _gToken, _router);
	}

	/*//////////////////////////////////////////////////////////////
	                          INTERNAL COMPUTATION
	//////////////////////////////////////////////////////////////*/

	function _computeAccumulated(
		uint256 totalReward,
		uint256 totalStakeWeight,
		IdEDU dedu
	) internal view returns (uint256 accumulatedReward, uint256 rpsDelta) {
		if (totalStakeWeight == 0) return (0, 0);

		RewardsStorage storage $ = _rewardsStorage();

		uint256 dEDUSupply = dedu.totalSupply();
		uint256 gTokenSupply = IGToken($.gToken).totalSupply();
		uint256 aggregateSupply = dEDUSupply + gTokenSupply;

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

		uint256 balance = IERC20($.gainz).balanceOf(address(this));
		uint256 totalAdded = balance - $.rewardsReserve;
		if (totalAdded == 0) return;

		address dedu = IUniswapV2Router($.router).dEDU();
		uint256 totalStakeWeight = IGToken($.gToken).totalStakeWeight();
		if (totalStakeWeight == 0) {
			IERC20($.gainz).transfer(dedu, totalAdded);

			emit RewardsRedirectedToDEDU(totalAdded);
			return;
		}

		(uint256 holdersShare, uint256 rps) = _computeAccumulated(
			totalAdded,
			totalStakeWeight,
			IdEDU(dedu)
		);

		$.rewardsReserve += holdersShare;
		$.rewardPerShare += rps;

		uint256 dEDUShare = totalAdded - holdersShare;
		IERC20($.gainz).transfer(dedu, dEDUShare);

		emit RewardsUpdated(
			totalAdded,
			holdersShare,
			dEDUShare,
			$.rewardPerShare
		);
	}

	/*//////////////////////////////////////////////////////////////
	                           USER ACTIONS
	//////////////////////////////////////////////////////////////*/

	function claimRewards(uint256[] memory nonces, address to) external {
		RewardsStorage storage $ = _rewardsStorage();

		IGainz($.gainz).mintGainz();
		uint256 currentEpoch = IGainz($.gainz).epochs().currentEpoch();

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
		IERC20($.gainz).transfer(to, claimable);

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
			IGainz($.gainz).stakersGainzToEmit(),
			IGToken($.gToken).totalStakeWeight(),
			IdEDU(IUniswapV2Router($.router).dEDU())
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

	function gainz() external view returns (address) {
		return _rewardsStorage().gainz;
	}

	function gToken() external view returns (address) {
		return _rewardsStorage().gToken;
	}
}
