// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Epochs} from "../../libraries/Epochs.sol";
import {IRewards} from "../../staking/IRewards.sol";
import {Entities, WorkEmission} from "./WorkEmission.sol";
import {WorkInfo} from "./WorkInfo.sol";
import {IHederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";
import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

/**
 * @title WorkEmissionController
 * @notice Hedera-native emission controller for WRK HTS token.
 * @dev Token accounting stays in HTS. This contract only controls emission and distribution.
 */
contract WorkEmissionController is Ownable {
	using Epochs for Epochs.Storage;
	using Entities for Entities.Value;

	address private constant HTS_PRECOMPILE = address(0x167);
	IHederaTokenService private constant hts = IHederaTokenService(HTS_PRECOMPILE);

	address public wrkToken;
	address public rewards;
	uint256 public lastTimestamp;
	uint256 public trackedSupply;
	Epochs.Storage public epochs;
	Entities.Value public entityFunds;

	error InvalidAddress();
	error WorkTokenAlreadyCreated();
	error WorkTokenNotCreated();
	error HederaCallFailed(int64 responseCode);
	error MaxSupplyExceeded(
		uint256 trackedSupply,
		uint256 amountToMint,
		uint256 maxSupply
	);

	event WorkControllerInitialized(
		address indexed owner,
		address indexed wrkToken,
		uint256 timestamp
	);
	event StakingRewardsCollectorUpdated(
		address indexed previous,
		address indexed current
	);
	event EmissionGenerated(
		uint256 indexed epoch,
		uint256 amount,
		uint256 timestamp
	);
	event StakingRewardsDispatched(
		address indexed rewards,
		uint256 stakingAmount,
		uint256 timestamp
	);
	event WorkDistributed(
		address indexed to,
		bytes32 indexed entity,
		uint256 amount,
		uint256 timestamp
	);
	event WorkTokenCreated(
		address indexed token,
		uint256 initialSupply,
		uint256 maxSupply,
		uint256 timestamp
	);
	event WorkBurned(
		address indexed holder,
		uint256 amount,
		uint256 timestamp
	);

	constructor(address initialOwner) Ownable(initialOwner) {
		if (initialOwner == address(0)) {
			revert InvalidAddress();
		}

		lastTimestamp = block.timestamp;
		epochs.initialize(24 hours);

		emit WorkControllerInitialized(owner(), wrkToken, block.timestamp);
	}

	/**
	 * @notice Creates the WRK HTS token and sets this controller as treasury/admin/supply key.
	 * @dev Must be called once by the owner after initialization. Requires HBAR to cover HTS token creation fee.
	 */
	function createWorkToken() external payable onlyOwner returns (address) {
		if (wrkToken != address(0)) {
			revert WorkTokenAlreadyCreated();
		}

		address tokenAddress = _createWorkToken(msg.value);
		_transferWRK(address(this), owner(), WorkInfo.ICO_FUNDS);

		return tokenAddress;
	}

	function setStakingRewardsCollector(address rewards_) public onlyOwner {
		if (rewards_ == address(0)) {
			revert InvalidAddress();
		}

		address previous = rewards;
		rewards = rewards_;

		emit StakingRewardsCollectorUpdated(previous, rewards);
	}

	function mintWork() external {
		uint256 workToEmit;

		(lastTimestamp, workToEmit) = _generateEmission();
		if (workToEmit == 0) return;

		entityFunds.add(Entities.fromTotalValue(workToEmit));
		emit EmissionGenerated(epochs.currentEpoch(), workToEmit, block.timestamp);

		_mintWRK(workToEmit);

		uint256 stakingAmount = entityFunds.staking;
		if (stakingAmount == 0) return;
		if (rewards == address(0)) {
			revert InvalidAddress();
		}

		_transferWRK(address(this), rewards, stakingAmount);
		entityFunds.staking = 0;

		IRewards(rewards).updateRewardReserve();
		emit StakingRewardsDispatched(rewards, stakingAmount, block.timestamp);
	}

	function burnWork(uint256 amount) external {
		if (amount == 0) return;

		_transferWRK(msg.sender, address(this), amount);
		_burnWRK(amount);
		emit WorkBurned(msg.sender, amount, block.timestamp);
	}

	function sendWork(address to, string memory entity) external onlyOwner {
		if (to == address(0)) {
			revert InvalidAddress();
		}

		uint256 amount = entityFunds.get(entity);
		if (amount == 0) return;

		_transferWRK(address(this), to, amount);
		entityFunds.reset(entity);

		emit WorkDistributed(
			to,
			keccak256(abi.encodePacked(entity)),
			amount,
			block.timestamp
		);
	}

	function stakersWorkToEmit() public view returns (uint256 toEmit) {
		(, toEmit) = _generateEmission();

		toEmit = Entities.fromTotalValue(toEmit).addReturn(entityFunds).staking;
	}

	function currentEpoch() public view returns (uint256) {
		return epochs.currentEpoch();
	}

	function entityFundFor(string memory entity) external view returns (uint256) {
		return entityFunds.get(entity);
	}

	function _computeEdgeEmissions(
		uint256 epoch,
		uint256 lastTimestamp_,
		uint256 currentTimestamp
	) internal view returns (uint256) {
		require(
			currentTimestamp > lastTimestamp_,
			"Work._computeEdgeEmissions: Invalid currentTimestamp"
		);

		(uint256 startTimestamp, uint256 endTimestamp) = epochs
			.epochEdgeTimestamps(epoch);

		uint256 upperBoundTime = 0;
		uint256 lowerBoundTime = 0;

		if (
			startTimestamp <= currentTimestamp &&
			currentTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp;
			lowerBoundTime = lastTimestamp_ <= startTimestamp
				? startTimestamp
				: lastTimestamp_;
		} else if (
			startTimestamp <= lastTimestamp_ && lastTimestamp_ <= endTimestamp
		) {
			upperBoundTime = currentTimestamp <= endTimestamp
				? currentTimestamp
				: endTimestamp;
			lowerBoundTime = lastTimestamp_;
		} else {
			revert("Work._computeEdgeEmissions: Invalid timestamps");
		}

		return
			WorkEmission.throughTimeRange(
				epoch,
				upperBoundTime - lowerBoundTime,
				epochs.epochLength
			);
	}

	function _generateEmission()
		internal
		view
		returns (uint256 newLastTimestamp, uint256 workToEmit)
	{
		uint256 currentTimestamp = block.timestamp;
		uint256 last = lastTimestamp;

		if (last < currentTimestamp) {
			uint256 lastGenerateEpoch = epochs.computeEpoch(last);
			workToEmit = _computeEdgeEmissions(
				lastGenerateEpoch,
				last,
				currentTimestamp
			);

			uint256 _currentEpoch = epochs.currentEpoch();
			if (_currentEpoch > lastGenerateEpoch) {
				uint256 intermediateEpochs = _currentEpoch -
					lastGenerateEpoch -
					1;

				if (intermediateEpochs > 0) {
					workToEmit += WorkEmission.throughEpochRange(
						lastGenerateEpoch + 1,
						_currentEpoch
					);
				}

				workToEmit += _computeEdgeEmissions(
					_currentEpoch,
					last,
					currentTimestamp
				);
			}

			last = currentTimestamp;
		}

		newLastTimestamp = last;
	}

	function _createWorkToken(
		uint256 hbarAmount
	) private returns (address tokenAddress) {
		// Official HTS tutorial pattern: build HederaToken struct and call precompile at 0x167.
		IHederaTokenService.KeyValue memory contractKey = IHederaTokenService
			.KeyValue({
				inheritAccountKey: false,
				contractId: address(this),
				ed25519: "",
				ECDSA_secp256k1: "",
				delegatableContractId: address(0)
			});

		IHederaTokenService.HederaToken memory token;
		token.name = "Work";
		token.symbol = "WRK";
		token.treasury = address(this);
		token.memo = "wrk-emission-token";
		token.tokenSupplyType = true; // finite
		token.maxSupply = _toInt64(WorkInfo.MAX_SUPPLY);
		token.freezeDefault = false;
		token.tokenKeys = new IHederaTokenService.TokenKey[](2);
		token.tokenKeys[0] = IHederaTokenService.TokenKey(0x1, contractKey); // admin key
		token.tokenKeys[1] = IHederaTokenService.TokenKey(0x10, contractKey); // supply key
		token.expiry = IHederaTokenService.Expiry(
			0,
			address(this),
			_toInt64(90 days)
		);

		(int64 responseCode, address createdToken) = IHederaTokenService(
			HTS_PRECOMPILE
		).createFungibleToken{value: hbarAmount}(
			token,
			_toInt64(WorkInfo.ICO_FUNDS),
			_toInt32(WorkInfo.DECIMALS)
		);
		_requireSuccess(responseCode);

		wrkToken = createdToken;
		trackedSupply = WorkInfo.ICO_FUNDS;

		emit WorkTokenCreated(
			createdToken,
			WorkInfo.ICO_FUNDS,
			WorkInfo.MAX_SUPPLY,
			block.timestamp
		);

		return createdToken;
	}

	function _mintWRK(uint256 amount) internal {
		address tokenAddress = wrkToken;
		_requireWorkTokenCreated(tokenAddress);
		if (
			trackedSupply > WorkInfo.MAX_SUPPLY ||
			amount > (WorkInfo.MAX_SUPPLY - trackedSupply)
		) {
			revert MaxSupplyExceeded(
				trackedSupply,
				amount,
				WorkInfo.MAX_SUPPLY
			);
		}

		int64 mintAmount = _toInt64(amount);
		(int64 responseCode, , ) = hts.mintToken(
			tokenAddress,
			mintAmount,
			new bytes[](0)
		);
		_requireSuccess(responseCode);

		trackedSupply += amount;
	}

	function _burnWRK(uint256 amount) internal {
		address tokenAddress = wrkToken;
		_requireWorkTokenCreated(tokenAddress);
		int64 burnAmount = _toInt64(amount);

		(int64 responseCode, ) = hts.burnToken(
			tokenAddress,
			burnAmount,
			new int64[](0)
		);
		_requireSuccess(responseCode);

		trackedSupply -= amount;
	}

	function _transferWRK(address from, address to, uint256 amount) internal {
		if (amount == 0) return;

		address tokenAddress = wrkToken;
		_requireWorkTokenCreated(tokenAddress);
		int64 transferAmount = _toTransferAmount(amount);
		int64 responseCode = hts.transferToken(
			tokenAddress,
			from,
			to,
			transferAmount
		);
		_requireSuccess(responseCode);
	}

	function _requireSuccess(int64 responseCode) internal pure {
		if (responseCode != HederaResponseCodes.SUCCESS) {
			revert HederaCallFailed(responseCode);
		}
	}

	function _requireWorkTokenCreated(address tokenAddress) internal pure {
		if (tokenAddress == address(0)) {
			revert WorkTokenNotCreated();
		}
	}

	function _toTransferAmount(uint256 amount) internal pure returns (int64) {
		return SafeCast.toInt64(SafeCast.toInt256(amount));
	}

	function _toInt64(uint256 amount) internal pure returns (int64) {
		return SafeCast.toInt64(SafeCast.toInt256(amount));
	}

	function _toInt32(uint256 amount) internal pure returns (int32) {
		return SafeCast.toInt32(SafeCast.toInt256(amount));
	}
}
