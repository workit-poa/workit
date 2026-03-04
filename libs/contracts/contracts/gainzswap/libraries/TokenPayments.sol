// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import {SFT} from "../abstracts/SFT.sol";
import {DEDU} from "../tokens/dEDU/dEDU.sol";

struct TokenPayment {
	address token;
	uint256 amount;
	uint256 nonce;
}

library TokenPayments {
	using Address for address;

	function receiveSFT(TokenPayment memory payment) internal {
		// SFT payment
		SFT(payment.token).safeTransferFrom(
			msg.sender,
			address(this),
			payment.nonce,
			payment.amount,
			""
		);
	}

	function receiveTokenFor(
		TokenPayment memory payment,
		address from,
		address to,
		address wNTV
	) internal {
		if (payment.token == address(0)) {
			// Wrap native tokens for `to`
			DEDU(payable(wNTV)).receiveFor{value: payment.amount}(to);
		} else if (payment.nonce == 0) {
			// ERC20 payment
			IERC20(payment.token).transferFrom(from, to, payment.amount);
		} else {
			// SFT payment
			SFT(payment.token).safeTransferFrom(
				from,
				to,
				payment.nonce,
				payment.amount,
				""
			);
		}
	}

	function sendFungibleToken(
		address token,
		uint256 amount,
		address to
	) internal {
		IERC20(token).transfer(to, amount);
	}

	function sendToken(TokenPayment memory payment, address to) internal {
		if (payment.nonce == 0) {
			sendFungibleToken(payment.token, payment.amount, to);
		} else {
			// SFT payment
			SFT(payment.token).safeTransferFrom(
				address(this),
				to,
				payment.nonce,
				payment.amount,
				""
			);
		}
	}

	function approve(TokenPayment memory payment, address to) internal {
		if (payment.nonce == 0) {
			// ERC20 approval
			IERC20(payment.token).approve(to, payment.amount);
		} else {
			// SFT approval
			SFT(payment.token).setApprovalForAll(to, true);
		}
	}
}
