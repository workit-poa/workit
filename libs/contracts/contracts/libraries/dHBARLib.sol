// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IdHBAR} from "../tokens/dHBAR/IdHBAR.sol";
import {IWHBAR} from "../interfaces/IWHBAR.sol";

/// @title dHBARLib
/// @notice Address-based helpers for wrapping HBAR / WHBAR into dHBAR
/// @dev Use via: `using dHBARLib for address;`
library dHBARLib {
	/// @notice Wrap native HBAR into dHBAR
	/// @param dHBAR Address of dHBAR contract
	/// @param amount Amount of native HBAR to wrap
	/// @return wrapped Amount of dHBAR received
	function _wrapHBAR(
		address dHBAR,
		uint256 amount
	) internal returns (uint256 wrapped) {
		uint256 beforeBal = IERC20(dHBAR).balanceOf(address(this));

		IdHBAR(dHBAR).receiveFor{value: amount}(address(this));

		wrapped = IERC20(dHBAR).balanceOf(address(this)) - beforeBal;
	}

	/// @notice Convert WHBAR → HBAR → dHBAR
	/// @param whbar Address of WHBAR contract
	/// @param dHBAR Address of dHBAR contract
	/// @param amount Amount of WHBAR to wrap
	/// @return wrapped Amount of dHBAR received
	function _wrapWHBAR(
		address whbar,
		address dHBAR,
		uint256 amount
	) internal returns (uint256 wrapped) {
		// Pull WHBAR from caller
		IERC20(whbar).transferFrom(msg.sender, address(this), amount);
		IERC20(whbar).approve(dHBAR, amount);

		uint256 beforeBal = IERC20(dHBAR).balanceOf(address(this));

		IdHBAR(dHBAR).delegateWHBAR(amount);

		wrapped = IERC20(dHBAR).balanceOf(address(this)) - beforeBal;
	}
}
