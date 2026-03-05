// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {GToken} from "../tokens/GToken/GToken.sol";

contract GTokenV2 is GToken {
	function version() external pure returns (uint256) {
		return 2;
	}
}
