// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract MockStakingForLaunchpad {
	address private _workToken;

	constructor(address workToken_) {
		_workToken = workToken_;
	}

	function workToken() external view returns (address) {
		return _workToken;
	}

	function stakeLiquidityIn(
		address,
		uint256,
		address,
		uint256
	) external pure {}
}
