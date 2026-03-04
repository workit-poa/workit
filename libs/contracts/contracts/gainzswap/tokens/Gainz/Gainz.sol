// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20BurnableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20BurnableUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {GainzInfo} from "./GainzInfo.sol";
import {GainzEmission, Entities} from "./GainzEmission.sol";
import {IGainz} from "./IGainz.sol";
import {IRewards} from "../../staking/IRewards.sol";

import {Epochs} from "../../libraries/Epochs.sol";

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title Gainz
 * @dev ERC20Upgradeable token representing the Academy-DEX base token. This token is mintable only upon deployment,
 * with the total supply set to the maximum defined in the `GainzInfo` library. The token is burnable
 * and is controlled by the owner of the contract.
 */
contract Gainz is
	IGainz,
	Initializable,
	ERC20Upgradeable,
	ERC20BurnableUpgradeable,
	OwnableUpgradeable
{
	using Epochs for Epochs.Storage;
	using Entities for Entities.Value;

	/// @custom:storage-location erc7201:gainz.GainzERC20.storage
	struct GainzERC20Storage {
		Epochs.Storage epochs;
		uint256 lastTimestamp;
		address governance;
		Entities.Value entityFunds; // Funds allocated to entities
	}

	// keccak256(abi.encode(uint256(keccak256("gainz.GainzERC20.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant GainzERC20_STORAGE_LOCATION =
		0x134accceb8ccd8549f1b5f4bf51d65d2512a1d4b87f29353424fe2bf01de7f00;

	function _getGainzERC20Storage()
		private
		pure
		returns (GainzERC20Storage storage $)
	{
		assembly {
			$.slot := GainzERC20_STORAGE_LOCATION
		}
	}

	/**
	 * @dev Initializes the ERC20Upgradeable token with the name "Gainz Token" and symbol "Gainz".
	 * Mints the maximum supply of tokens to the contract owner.
	 */
	function initialize() public initializer {
		__ERC20_init("Gainz Token", "Gainz");
		__Ownable_init(msg.sender);

		GainzERC20Storage storage $ = _getGainzERC20Storage();

		$.lastTimestamp = block.timestamp;
		$.epochs.initialize(24 hours);

		_mint(msg.sender, GainzInfo.ICO_FUNDS);
		_mint(address(this), GainzInfo.ECOSYSTEM_DISTRIBUTION_FUNDS);

		emit GainzInitialized(
			msg.sender,
			GainzInfo.ICO_FUNDS,
			GainzInfo.ECOSYSTEM_DISTRIBUTION_FUNDS
		);
	}

	function setStakingRewardsCollector(address rewards) external onlyOwner {
		require(rewards != address(0), "Invalid Address");

		GainzERC20Storage storage $ = _getGainzERC20Storage();
		address previous = $.governance;

		$.governance = rewards;

		emit StakingRewardsCollectorUpdated(previous, rewards);
	}

	function _computeEdgeEmissions(
		uint256 epoch,
		uint256 lastTimestamp,
		uint256 currentTimestamp
	) internal view returns (uint256) {
		require(
			currentTimestamp > lastTimestamp,
			"Gainz._computeEdgeEmissions: Invalid currentTimestamp"
		);

		GainzERC20Storage storage $ = _getGainzERC20Storage(); // Access namespaced storage

		(uint256 startTimestamp, uint256 endTimestamp) = $
			.epochs
			.epochEdgeTimestamps(epoch);

		uint256 upperBoundTime = 0;
		uint256 lowerBoundTime = 0;

		if (
			startTimestamp <= currentTimestamp &&
			currentTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp;
			lowerBoundTime = lastTimestamp <= startTimestamp
				? startTimestamp
				: lastTimestamp;
		} else if (
			startTimestamp <= lastTimestamp && lastTimestamp <= endTimestamp
		) {
			upperBoundTime = currentTimestamp <= endTimestamp
				? currentTimestamp
				: endTimestamp;
			lowerBoundTime = lastTimestamp;
		} else {
			revert("Gainz._computeEdgeEmissions: Invalid timestamps");
		}

		return
			GainzEmission.throughTimeRange(
				epoch,
				upperBoundTime - lowerBoundTime,
				$.epochs.epochLength
			);
	}

	function _generateEmission()
		private
		view
		returns (uint256 lastTimestamp, uint256 _gainzToEmit)
	{
		GainzERC20Storage storage $ = _getGainzERC20Storage();
		Epochs.Storage storage _epochs = $.epochs;

		uint256 currentTimestamp = block.timestamp;
		lastTimestamp = $.lastTimestamp;

		if (lastTimestamp < currentTimestamp) {
			uint256 lastGenerateEpoch = _epochs.computeEpoch(lastTimestamp);
			_gainzToEmit = _computeEdgeEmissions(
				lastGenerateEpoch,
				lastTimestamp,
				currentTimestamp
			);

			uint256 _currentEpoch = _epochs.currentEpoch();
			if (_currentEpoch > lastGenerateEpoch) {
				uint256 intermediateEpochs = _currentEpoch -
					lastGenerateEpoch -
					1;

				if (intermediateEpochs > 0) {
					_gainzToEmit += GainzEmission.throughEpochRange(
						lastGenerateEpoch + 1,
						_currentEpoch
					);
				}

				_gainzToEmit += _computeEdgeEmissions(
					_currentEpoch,
					lastTimestamp,
					currentTimestamp
				);
			}

			lastTimestamp = currentTimestamp;
		}
	}

	function mintGainz() external {
		GainzERC20Storage storage $ = _getGainzERC20Storage();
		uint256 gainzToEmit;

		($.lastTimestamp, gainzToEmit) = _generateEmission();
		if (gainzToEmit == 0) return;

		$.entityFunds.add(Entities.fromTotalValue(gainzToEmit));
		emit EmissionGenerated(
			$.epochs.currentEpoch(),
			gainzToEmit,
			block.timestamp
		);

		uint256 stakingAmount = $.entityFunds.staking;
		_transfer(address(this), $.governance, stakingAmount);
		$.entityFunds.staking = 0;

		(bool success, ) = $.governance.call(
			abi.encode(IRewards.updateRewardReserve.selector)
		);
		require(success, "Unable to mint");
		emit StakingRewardsDispatched(
			$.governance,
			stakingAmount,
			block.timestamp
		);
	}

	function sendGainz(
		address to,
		string memory _entityName
	) external onlyOwner returns (uint256 amount) {
		GainzERC20Storage storage $ = _getGainzERC20Storage();
		bytes32 entityName = keccak256(abi.encodePacked(_entityName));

		if (entityName == keccak256(abi.encodePacked("team"))) {
			amount = $.entityFunds.team;
			$.entityFunds.team = 0;
		} else if (entityName == keccak256(abi.encodePacked("growth"))) {
			amount = $.entityFunds.growth;
			$.entityFunds.growth = 0;
		} else if (entityName == keccak256(abi.encodePacked("liqIncentive"))) {
			amount = $.entityFunds.liqIncentive;
			$.entityFunds.liqIncentive = 0;
		}

		if (amount > 0) {
			_transfer(address(this), to, amount);
		}
	}

	// Stakers gainz
	function stakersGainzToEmit() public view returns (uint toEmit) {
		(, toEmit) = _generateEmission();

		toEmit = Entities
			.fromTotalValue(toEmit)
			.addReturn(_getGainzERC20Storage().entityFunds)
			.staking;
	}

	function epochs() public view returns (Epochs.Storage memory) {
		return _getGainzERC20Storage().epochs;
	}

	function currentEpoch() public view returns (uint256) {
		return epochs().currentEpoch();
	}
}
