// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockV2Pair is ERC20 {
	address public immutable token0;
	address public immutable token1;

	constructor(address token0_, address token1_) ERC20("Mock V2 LP", "MV2LP") {
		token0 = token0_;
		token1 = token1_;
	}

	function mint(address to, uint256 liquidity) external returns (uint256) {
		_mint(to, liquidity);
		return liquidity;
	}
}
