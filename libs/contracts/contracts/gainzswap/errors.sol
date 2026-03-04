// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TokenPayment} from "./libraries/TokenPayments.sol";

abstract contract Errors {
	error InvalidPath(address[] path);
	error InSufficientOutputAmount(address[] path, uint256 amount);
	error InvalidPayment(TokenPayment payment, uint256 value);
}
