// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
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
 * @dev Upgradeable via UUPS. Token accounting stays in HTS. This contract only controls emission and distribution.
 */
contract WorkEmissionController is
	Initializable,
	OwnableUpgradeable,
	UUPSUpgradeable
{
	using Epochs for Epochs.Storage;
	using Entities for Entities.Value;

	address private constant HTS_PRECOMPILE = address(0x167);
	IHederaTokenService private constant hts = IHederaTokenService(HTS_PRECOMPILE);

	/// @custom:storage-location erc7201:work.WorkEmissionController.storage
	struct WorkEmissionControllerStorage {
		address wrkToken;
		address rewards;
		uint256 lastTimestamp;
		uint256 trackedSupply;
		Epochs.Storage epochs;
		Entities.Value entityFunds;
	}

	// keccak256(abi.encode(uint256(keccak256("work.WorkEmissionController.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant WORK_EMISSION_CONTROLLER_STORAGE_LOCATION =
		0xdfea2e23e2524b8be93121290a16665b5af39cc33a84c867bbbe9d2c2c488400;

	function _getWorkEmissionControllerStorage()
		private
		pure
		returns (WorkEmissionControllerStorage storage $)
	{
		assembly {
			$.slot := WORK_EMISSION_CONTROLLER_STORAGE_LOCATION
		}
	}

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

	/// @custom:oz-upgrades-unsafe-allow constructor
	constructor() {
		_disableInitializers();
	}

	/**
	 * @notice Initializes upgradeability and ownership.
	 * @param initialOwner The owner that can administer emission and upgrades.
	 */
	function initialize(address initialOwner) external initializer {
		if (initialOwner == address(0)) {
			revert InvalidAddress();
		}

		__Ownable_init(initialOwner);

		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		$.lastTimestamp = block.timestamp;
		$.epochs.initialize(24 hours);

		emit WorkControllerInitialized(owner(), $.wrkToken, block.timestamp);
	}

	/**
	 * @notice Creates the WRK HTS token and sets this controller as treasury/admin/supply key.
	 * @dev Must be called once by the owner after initialization. Requires HBAR to cover HTS token creation fee.
	 */
	function createWorkToken() external payable onlyOwner returns (address) {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		if ($.wrkToken != address(0)) {
			revert WorkTokenAlreadyCreated();
		}

		return _createWorkToken(msg.value);
	}

	function setStakingRewardsCollector(address _rewards) public onlyOwner {
		if (_rewards == address(0)) {
			revert InvalidAddress();
		}

		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		address previous = $.rewards;
		$.rewards = _rewards;

		emit StakingRewardsCollectorUpdated(previous, $.rewards);
	}

	function mintWork() external {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		uint256 workToEmit;

		($.lastTimestamp, workToEmit) = _generateEmission();
		if (workToEmit == 0) return;

		$.entityFunds.add(Entities.fromTotalValue(workToEmit));
		emit EmissionGenerated($.epochs.currentEpoch(), workToEmit, block.timestamp);

		_mintWRK(workToEmit);

		uint256 stakingAmount = $.entityFunds.staking;
		if (stakingAmount == 0) return;
		if ($.rewards == address(0)) {
			revert InvalidAddress();
		}

		_transferWRK(address(this), $.rewards, stakingAmount);
		$.entityFunds.staking = 0;

		IRewards($.rewards).updateRewardReserve();
		emit StakingRewardsDispatched($.rewards, stakingAmount, block.timestamp);
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

		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		uint256 amount = $.entityFunds.get(entity);
		if (amount == 0) return;

		_transferWRK(address(this), to, amount);
		$.entityFunds.reset(entity);

		emit WorkDistributed(
			to,
			keccak256(abi.encodePacked(entity)),
			amount,
			block.timestamp
		);
	}

	function stakersWorkToEmit() public view returns (uint256 toEmit) {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		(, toEmit) = _generateEmission();

		toEmit = Entities.fromTotalValue(toEmit).addReturn($.entityFunds).staking;
	}

	function currentEpoch() public view returns (uint256) {
		return _getWorkEmissionControllerStorage().epochs.currentEpoch();
	}

	function wrkToken() public view returns (address) {
		return _getWorkEmissionControllerStorage().wrkToken;
	}

	function rewards() public view returns (address) {
		return _getWorkEmissionControllerStorage().rewards;
	}

	function lastTimestamp() public view returns (uint256) {
		return _getWorkEmissionControllerStorage().lastTimestamp;
	}

	function trackedSupply() public view returns (uint256) {
		return _getWorkEmissionControllerStorage().trackedSupply;
	}

	function epochs() public view returns (Epochs.Storage memory) {
		return _getWorkEmissionControllerStorage().epochs;
	}

	function entityFunds() public view returns (Entities.Value memory) {
		return _getWorkEmissionControllerStorage().entityFunds;
	}

	function entityFundFor(string memory entity) external view returns (uint256) {
		return _getWorkEmissionControllerStorage().entityFunds.get(entity);
	}

	function _computeEdgeEmissions(
		uint256 epoch,
		uint256 _lastTimestamp,
		uint256 currentTimestamp
	) internal view returns (uint256) {
		require(
			currentTimestamp > _lastTimestamp,
			"Work._computeEdgeEmissions: Invalid currentTimestamp"
		);

		Epochs.Storage storage _epochs = _getWorkEmissionControllerStorage().epochs;
		(uint256 startTimestamp, uint256 endTimestamp) = _epochs
			.epochEdgeTimestamps(epoch);

		uint256 upperBoundTime = 0;
		uint256 lowerBoundTime = 0;

		if (
			startTimestamp <= currentTimestamp &&
			currentTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp;
			lowerBoundTime = _lastTimestamp <= startTimestamp
				? startTimestamp
				: _lastTimestamp;
		} else if (
			startTimestamp <= _lastTimestamp && _lastTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp <= endTimestamp
				? currentTimestamp
				: endTimestamp;
			lowerBoundTime = _lastTimestamp;
		} else {
			revert("Work._computeEdgeEmissions: Invalid timestamps");
		}

		return
			WorkEmission.throughTimeRange(
				epoch,
				upperBoundTime - lowerBoundTime,
				_epochs.epochLength
			);
	}

	function _generateEmission()
		internal
		view
		returns (uint256 _lastTimestamp, uint256 workToEmit)
	{
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		uint256 currentTimestamp = block.timestamp;
		_lastTimestamp = $.lastTimestamp;

		if (_lastTimestamp < currentTimestamp) {
			uint256 lastGenerateEpoch = $.epochs.computeEpoch(_lastTimestamp);
			workToEmit = _computeEdgeEmissions(
				lastGenerateEpoch,
				_lastTimestamp,
				currentTimestamp
			);

			uint256 _currentEpoch = $.epochs.currentEpoch();
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
					_lastTimestamp,
					currentTimestamp
				);
			}

			_lastTimestamp = currentTimestamp;
		}
	}

	function _createWorkToken(
		uint256 hbarAmount
	) private returns (address tokenAddress) {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();

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

		$.wrkToken = createdToken;
		$.trackedSupply = WorkInfo.ICO_FUNDS;

		emit WorkTokenCreated(
			createdToken,
			WorkInfo.ICO_FUNDS,
			WorkInfo.MAX_SUPPLY,
			block.timestamp
		);

		return createdToken;
	}

	function _mintWRK(uint256 amount) internal {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		address tokenAddress = $.wrkToken;
		_requireWorkTokenCreated(tokenAddress);
		if (
			$.trackedSupply > WorkInfo.MAX_SUPPLY ||
			amount > (WorkInfo.MAX_SUPPLY - $.trackedSupply)
		) {
			revert MaxSupplyExceeded(
				$.trackedSupply,
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

		$.trackedSupply += amount;
	}

	function _burnWRK(uint256 amount) internal {
		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		address tokenAddress = $.wrkToken;
		_requireWorkTokenCreated(tokenAddress);
		int64 burnAmount = _toInt64(amount);

		(int64 responseCode, ) = hts.burnToken(
			tokenAddress,
			burnAmount,
			new int64[](0)
		);
		_requireSuccess(responseCode);

		$.trackedSupply -= amount;
	}

	function _transferWRK(address from, address to, uint256 amount) internal {
		if (amount == 0) return;

		WorkEmissionControllerStorage storage $ = _getWorkEmissionControllerStorage();
		address tokenAddress = $.wrkToken;
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

	function _authorizeUpgrade(address) internal override onlyOwner {}

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
