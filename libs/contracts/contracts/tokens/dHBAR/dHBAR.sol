// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV2Router} from "../../interfaces/IUniswapV2Router.sol";

import {LST} from "./LST.sol";
import {IdHBAR} from "./IdHBAR.sol";

/// @title DHBAR (Delegated HBAR)
/// @notice Workit's delegated HBAR staking mechanism. Also powers HBAR liquidity on the DEX
/// @dev Now includes quadratic emission scaling based on total supply vs. target supply.
contract DHBAR is Initializable, LST, IdHBAR, OwnableUpgradeable {
	/// @custom:storage-location erc7201:workit.tokens.WNTV.storage
	struct DHBARStore {
		address payable yuzuAggregator;
		mapping(address => UserWithdrawal) withdrawals;
		uint256 pendingWithdrawals;
		uint256 targetSupply; // Target total supply for quadratic emission scaling
		address router;
	}

	// keccak256(abi.encode(uint256(keccak256("workit.tokens.WNTV.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant DHBAR_STORAGE_SLOT =
		0x9c939a4b05ceda8b86db186f0245ad77465dc7a372c22a1f429a973574185700;

	function _getDHBARStorage() private pure returns (DHBARStore storage $) {
		assembly {
			$.slot := DHBAR_STORAGE_SLOT
		}
	}

	// ----------------------------------
	// INITIALIZATION
	// ----------------------------------

	/// @notice Initializes the contract and sets token metadata.
	function initialize(address initialOwner, IERC20 workit) public initializer {
		__ERC20_init("Delegated HBAR", "dHBAR");
		__LST_init(workit);
		__Ownable_init(initialOwner);
	}

	// ----------------------------------
	// OWNER-ONLY FUNCTIONS
	// ----------------------------------

	/// @notice Sets the Yuzu aggregator address.
	function setYuzuAggregator(
		address _stakingRewardsCollector
	) external onlyOwner {
		_getDHBARStorage().yuzuAggregator = payable(_stakingRewardsCollector);
		emit YuzuAggregatorUpdated(_stakingRewardsCollector);
	}

	/// @notice Sets the router address used to resolve WHBAR.
	function setRouter(address _router) external onlyOwner {
		require(_router != address(0), "DHBAR: router cannot be zero");
		_getDHBARStorage().router = _router;
	}

	// ----------------------------------
	// PUBLIC / EXTERNAL FUNCTIONS
	// ----------------------------------

	/// @notice Deposits native tokens and approves a spender to use them.
	function receiveForSpender(address owner, address spender) public payable {
		_stakeHBAR(owner);
		_approve(owner, spender, msg.value);
	}

	/// @notice Deposits native tokens and mints DHBAR tokens for the sender.
	function receiveFor(address owner) public payable {
		_stakeHBAR(owner);
	}

	/// @notice Delegates WHBAR through the Yuzu aggregator and mints dHBAR.
	function delegateWHBAR(uint256 amount) external {
		require(amount > 0, "DHBAR: amount must be > 0");

		address yuzuAggregator_ = address(_getDHBARStorage().yuzuAggregator);
		require(yuzuAggregator_ != address(0), "DHBAR: yuzuAggregator not set");

		address router_ = _getDHBARStorage().router;
		require(router_ != address(0), "DHBAR: router not set");

		address whbar = IUniswapV2Router(router_).WHBAR();
		require(whbar != address(0), "DHBAR: WHBAR not configured");

		require(
			IERC20(whbar).transferFrom(msg.sender, yuzuAggregator_, amount),
			"DHBAR: WHBAR transfer failed"
		);

		_mintAndEmitDeposit(msg.sender, amount);
	}

	/// @notice Initiates a withdrawal request for DHBAR tokens.
	function withdraw(uint256 amount) public {
		address user = msg.sender;
		require(balanceOf(user) >= amount, "DHBAR: Insufficient balance");

		_claimReward(user);
		_burn(user, amount);

		UserWithdrawal storage withdrawal = _getDHBARStorage().withdrawals[user];
		withdrawal.readyTimestamp =
			block.timestamp -
			(block.timestamp % 1 days) +
			30 hours;
		withdrawal.amount += amount;

		_getDHBARStorage().pendingWithdrawals += amount;
		emit WithdrawalRequested(user, amount, withdrawal.readyTimestamp);
	}

	/// @notice Completes a matured withdrawal.
	function completeWithdrawal() external {
		address user = msg.sender;

		UserWithdrawal storage withdrawal = _getDHBARStorage().withdrawals[user];
		require(
			withdrawal.readyTimestamp <= block.timestamp,
			"Withdrawal not ready"
		);

		uint256 amount = withdrawal.amount;
		delete _getDHBARStorage().withdrawals[user];

		(bool success, ) = payable(user).call{value: amount}("");
		require(success, "HBAR transfer failed");

		emit WithdrawalCompleted(user, amount);
	}

	/// @notice Settles pending withdrawals by reducing the pending amount.
	function settleWithdrawals() external payable {
		_getDHBARStorage().pendingWithdrawals -= msg.value;
	}

	/// @notice Sends all native HBAR in this contract to the Yuzu aggregator.
	function sendAllBalanceToYuzuAggregator() external {
		address payable yuzuAggregator_ = _getDHBARStorage().yuzuAggregator;
		require(yuzuAggregator_ != address(0), "DHBAR: yuzuAggregator not set");

		uint256 balance = address(this).balance;
		(bool success, ) = yuzuAggregator_.call{value: balance}("");
		require(success, "DHBAR: transfer to yuzuAggregator failed");
	}

	/// @notice Allows direct deposits of native tokens.
	receive() external payable {
		_stakeHBAR(msg.sender);
	}

	// ----------------------------------
	// INTERNAL FUNCTIONS
	// ----------------------------------

	/// @dev Stakes native tokens with the Yuzu aggregator and mints DHBAR tokens.
	function _stakeHBAR(address depositor) internal {
		address payable stakingRewardsCollector_ = _getDHBARStorage()
			.yuzuAggregator;
		require(
			stakingRewardsCollector_ != address(0),
			"DHBAR: yuzuAggregator not set"
		);

		uint256 delegatedAmt = msg.value;

		(bool success, ) = stakingRewardsCollector_.call{value: delegatedAmt}(
			""
		);
		require(success, "Failed to stake for Yuzu");

		_mintAndEmitDeposit(depositor, delegatedAmt);
	}

	function _mintAndEmitDeposit(address depositor, uint256 amount) internal {
		_mint(depositor, amount);
		emit Deposited(depositor, amount);
	}

	// ----------------------------------
	// VIEW FUNCTIONS
	// ----------------------------------

	/// @notice Returns the address of the Yuzu aggregator.
	function stakingRewardsCollector() external view returns (address) {
		return _getDHBARStorage().yuzuAggregator;
	}

	/// @notice Returns the router address used to source the WHBAR token.
	function routerAddress() external view returns (address) {
		return _getDHBARStorage().router;
	}

	/// @notice Returns the total pending withdrawals.
	function pendingWithdrawals() external view returns (uint256) {
		return _getDHBARStorage().pendingWithdrawals;
	}

	/// @notice Returns a user's pending withdrawals.
	function userPendingWithdrawals(
		address user
	) external view returns (UserWithdrawal memory) {
		return _getDHBARStorage().withdrawals[user];
	}
}
