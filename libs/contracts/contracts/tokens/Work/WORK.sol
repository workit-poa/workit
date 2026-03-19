// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {Epochs} from "../../libraries/Epochs.sol";
import {IRewards} from "../../staking/IRewards.sol";
import {Entities, WorkEmission} from "./WorkEmission.sol";
import {WorkInfo} from "./WorkInfo.sol";
import {IHederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";
import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";
import {SafeHederaTokenService, HederaTokenService} from "../../vendor/hedera/SafeHederaTokenService.sol";

/**
 * @title WORK
 * @notice Hedera-native emission controller for WRK HTS token.
 * @dev Token accounting stays in HTS. This contract only controls emission and distribution.
 */
contract WORK is OwnableUpgradeable, UUPSUpgradeable, SafeHederaTokenService {
    using Epochs for Epochs.Storage;
    using Entities for Entities.Value;

    address public token;
    address public rewards;
    Epochs.Storage public epochs;
    uint256 public lastTimestamp;
    Entities.Value public entityFunds;

    error InvalidAddress();
    error TokenCreationFailed(int256 responseCode);
    error TokenNotCreated();

    event WorkControllerInitialized(
        address indexed owner,
        address indexed token,
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
        uint256 stakingRewards,
        uint256 timestamp
    );

    constructor() {
        _disableInitializers();
    }

    function initialize(address initialOwner) external initializer {
        __Ownable_init(initialOwner);

        if (initialOwner == address(0)) {
            revert InvalidAddress();
        }

        lastTimestamp = block.timestamp;
        epochs.initialize(24 hours);

        emit WorkControllerInitialized(owner(), token, block.timestamp);
    }

    function createWorkToken() external payable onlyOwner returns (address) {
        if (token != address(0)) return token;
        _createWorkToken();
        return token;
    }

    function setStakingRewardsCollector(address rewards_) public onlyOwner {
        if (rewards_ == address(0)) {
            revert InvalidAddress();
        }

        address previous = rewards;
        rewards = rewards_;

        emit StakingRewardsCollectorUpdated(previous, rewards);
    }

    function emitTokens() external {
        uint256 workToEmit;

        (lastTimestamp, workToEmit) = _generateEmission();
        if (workToEmit == 0) return;

        entityFunds.add(Entities.fromTotalValue(workToEmit));
        emit EmissionGenerated(
            epochs.currentEpoch(),
            workToEmit,
            block.timestamp
        );

        _safeMintToken(token, address(this), workToEmit, new bytes[](0));

        uint256 stakingRewards = entityFunds.staking;
        if (stakingRewards == 0) return;
        if (rewards == address(0)) {
            revert InvalidAddress();
        }

        _safeTransferToken(token, address(this), rewards, stakingRewards);
        entityFunds.staking = 0;

        IRewards(rewards).updateRewardReserve();
        emit StakingRewardsDispatched(rewards, stakingRewards, block.timestamp);
    }

    function stakersWorkToEmit() public view returns (uint256 toEmit) {
        (, toEmit) = _generateEmission();

        toEmit = Entities.fromTotalValue(toEmit).addReturn(entityFunds).staking;
    }

    function currentEpoch() public view returns (uint256) {
        return epochs.currentEpoch();
    }

    function entityFundFor(
        string memory entity
    ) external view returns (uint256) {
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

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _createWorkToken() internal {
        if (token != address(0)) return;

        IHederaTokenService.KeyValue memory supplyKey = IHederaTokenService
            .KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            });

        IHederaTokenService.TokenKey[]
            memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({keyType: 0x10, key: supplyKey});

        IHederaTokenService.HederaToken memory hederaToken;
        hederaToken.name = "Work";
        hederaToken.symbol = "WRK";
        hederaToken.treasury = address(this);
        hederaToken.memo = "Work token";
        hederaToken.tokenSupplyType = true;
        hederaToken.maxSupply = int64(uint64(WorkInfo.MAX_SUPPLY));
        hederaToken.freezeDefault = false;
        hederaToken.tokenKeys = keys;
        hederaToken.expiry = IHederaTokenService.Expiry(
            0,
            address(this),
            int64(uint64(90 days))
        );

        (int responseCode, address createdToken) = HederaTokenService
            .createFungibleToken(
                hederaToken,
                int64(0),
                int32(uint32(WorkInfo.DECIMALS))
            );

        if (responseCode != HederaResponseCodes.SUCCESS) {
            revert TokenCreationFailed(responseCode);
        }

        token = createdToken;

        // HTS mint credits the treasury account (this contract), so move the ICO
        // allocation to the owner explicitly for launchpad campaign seeding.
        _safeMintToken(token, address(this), WorkInfo.ICO_FUNDS, new bytes[](0));
        _safeTransferToken(token, address(this), owner(), WorkInfo.ICO_FUNDS);
    }

    uint256[50] private __gap;
}
