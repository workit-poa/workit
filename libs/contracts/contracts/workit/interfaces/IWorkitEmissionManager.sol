// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Epochs} from "../../gainzswap/libraries/Epochs.sol";

interface IWorkitEmissionManager {
	enum Entity {
		Team,
		Growth,
		LiquidityIncentive
	}

	function mintForStaking() external returns (uint256 minted);

	function pendingStakingEmission() external view returns (uint256);

	function claimEntityFunds(Entity entity, address to) external returns (uint256);

	function setTreasury(address treasury) external;

	function currentEpoch() external view returns (uint256);

	function epochs() external view returns (Epochs.Storage memory);
}
