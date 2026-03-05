// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockWorkEmissionController {
	uint256 private _currentEpoch;
	uint256 private _stakersWorkToEmit;

	function setCurrentEpoch(uint256 value) external {
		_currentEpoch = value;
	}

	function setStakersWorkToEmit(uint256 value) external {
		_stakersWorkToEmit = value;
	}

	function currentEpoch() external view returns (uint256) {
		return _currentEpoch;
	}

	function stakersWorkToEmit() external view returns (uint256) {
		return _stakersWorkToEmit;
	}
}
