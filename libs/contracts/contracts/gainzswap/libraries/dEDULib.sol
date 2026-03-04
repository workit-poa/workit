// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IdEDU} from "../tokens/dEDU/IdEDU.sol";
import {IWEDU} from "../interfaces/IWEDU.sol";

/// @title dEDULib
/// @notice Address-based helpers for wrapping EDU / WEDU into dEDU
/// @dev Use via: `using dEDULib for address;`
library dEDULib {
	/// @notice Wrap native EDU into dEDU
	/// @param dEDU Address of dEDU contract
	/// @param amount Amount of native EDU to wrap
	/// @return wrapped Amount of dEDU received
	function _wrapEDU(
		address dEDU,
		uint256 amount
	) internal returns (uint256 wrapped) {
		uint256 beforeBal = IERC20(dEDU).balanceOf(address(this));

		IdEDU(dEDU).receiveFor{value: amount}(address(this));

		wrapped = IERC20(dEDU).balanceOf(address(this)) - beforeBal;
	}

	/// @notice Convert WEDU → EDU → dEDU
	/// @param wedu Address of WEDU contract
	/// @param dEDU Address of dEDU contract
	/// @param amount Amount of WEDU to wrap
	/// @return wrapped Amount of dEDU received
	function _wrapWEDU(
		address wedu,
		address dEDU,
		uint256 amount
	) internal returns (uint256 wrapped) {
		// Pull WEDU from caller
		IERC20(wedu).transferFrom(msg.sender, address(this), amount);
		IERC20(wedu).approve(dEDU, amount);

		uint256 beforeBal = IERC20(dEDU).balanceOf(address(this));

		IdEDU(dEDU).delegateWEDU(amount);

		wrapped = IERC20(dEDU).balanceOf(address(this)) - beforeBal;
	}
}
