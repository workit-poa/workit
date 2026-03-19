// SPDX-License-Identifier: MIT
pragma solidity =0.6.12;

// Compile anchors so Hardhat emits artifacts for vendored SaucerSwap contracts.
import "../../vendor/saucerswap-core/contracts/UniswapV2Factory.sol";
import "../../vendor/saucerswap-core/contracts/UniswapV2Pair.sol";
import "../../vendor/saucerswap-core/contracts/WHBAR.sol";
import {UniswapV2Router02} from "../../vendor/saucerswap-periphery/contracts/UniswapV2Router02.sol";

contract SaucerContractsCompileAnchor {}
