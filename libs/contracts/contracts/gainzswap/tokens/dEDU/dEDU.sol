// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV2Router} from "../../interfaces/IUniswapV2Router.sol";

import {LST} from "./LST.sol";
import {IdEDU} from "./IdEDU.sol";

/// @title DEDU (Delegated EDU)
/// @notice GainzSwap's delegated EDU staking mechanism. Also powers EDU liquidity on the DEX
/// @dev Now includes quadratic emission scaling based on total supply vs. target supply.
contract DEDU is Initializable, LST, IdEDU, OwnableUpgradeable {
	/// @custom:storage-location erc7201:gainz.tokens.WNTV.storage
	struct DEDUStore {
		address payable yuzuAggregator;
		mapping(address => UserWithdrawal) withdrawals;
		uint256 pendingWithdrawals;
		uint256 targetSupply; // Target total supply for quadratic emission scaling
		address router;
	}

	// keccak256(abi.encode(uint256(keccak256("gainz.tokens.WNTV.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant DEDU_STORAGE_SLOT =
		0x9c939a4b05ceda8b86db186f0245ad77465dc7a372c22a1f429a973574185700;

	function _getDEDUStorage() private pure returns (DEDUStore storage $) {
		assembly {
			$.slot := DEDU_STORAGE_SLOT
		}
	}

	// ----------------------------------
	// INITIALIZATION
	// ----------------------------------

	/// @notice Initializes the contract and sets token metadata.
	function initialize(address initialOwner, IERC20 gainz) public initializer {
		__ERC20_init("Delegated EDU", "dEDU");
		__LST_init(gainz);
		__Ownable_init(initialOwner);
	}

	// ----------------------------------
	// OWNER-ONLY FUNCTIONS
	// ----------------------------------

	/// @notice Sets the Yuzu aggregator address.
	function setYuzuAggregator(
		address _stakingRewardsCollector
	) external onlyOwner {
		_getDEDUStorage().yuzuAggregator = payable(_stakingRewardsCollector);
		emit YuzuAggregatorUpdated(_stakingRewardsCollector);
	}

	/// @notice Sets the router address used to resolve WEDU.
	function setRouter(address _router) external onlyOwner {
		require(_router != address(0), "DEDU: router cannot be zero");
		_getDEDUStorage().router = _router;
	}

	// ----------------------------------
	// PUBLIC / EXTERNAL FUNCTIONS
	// ----------------------------------

	/// @notice Deposits native tokens and approves a spender to use them.
	function receiveForSpender(address owner, address spender) public payable {
		_stakeEDU(owner);
		_approve(owner, spender, msg.value);
	}

	/// @notice Deposits native tokens and mints DEDU tokens for the sender.
	function receiveFor(address owner) public payable {
		_stakeEDU(owner);
	}

	/// @notice Delegates WEDU through the Yuzu aggregator and mints dEDU.
	function delegateWEDU(uint256 amount) external {
		require(amount > 0, "DEDU: amount must be > 0");

		address yuzuAggregator_ = address(_getDEDUStorage().yuzuAggregator);
		require(yuzuAggregator_ != address(0), "DEDU: yuzuAggregator not set");

		address router_ = _getDEDUStorage().router;
		require(router_ != address(0), "DEDU: router not set");

		address wedu = IUniswapV2Router(router_).WEDU();
		require(wedu != address(0), "DEDU: WEDU not configured");

		require(
			IERC20(wedu).transferFrom(msg.sender, yuzuAggregator_, amount),
			"DEDU: WEDU transfer failed"
		);

		_mintAndEmitDeposit(msg.sender, amount);
	}

	/// @notice Initiates a withdrawal request for DEDU tokens.
	function withdraw(uint256 amount) public {
		address user = msg.sender;
		require(balanceOf(user) >= amount, "DEDU: Insufficient balance");

		_claimReward(user);
		_burn(user, amount);

		UserWithdrawal storage withdrawal = _getDEDUStorage().withdrawals[user];
		withdrawal.readyTimestamp =
			block.timestamp -
			(block.timestamp % 1 days) +
			30 hours;
		withdrawal.amount += amount;

		_getDEDUStorage().pendingWithdrawals += amount;
		emit WithdrawalRequested(user, amount, withdrawal.readyTimestamp);
	}

	/// @notice Completes a matured withdrawal.
	function completeWithdrawal() external {
		address user = msg.sender;

		UserWithdrawal storage withdrawal = _getDEDUStorage().withdrawals[user];
		require(
			withdrawal.readyTimestamp <= block.timestamp,
			"Withdrawal not ready"
		);

		uint256 amount = withdrawal.amount;
		delete _getDEDUStorage().withdrawals[user];

		(bool success, ) = payable(user).call{value: amount}("");
		require(success, "EDU transfer failed");

		emit WithdrawalCompleted(user, amount);
	}

	/// @notice Settles pending withdrawals by reducing the pending amount.
	function settleWithdrawals() external payable {
		_getDEDUStorage().pendingWithdrawals -= msg.value;
	}

	/// @notice Sends all native EDU in this contract to the Yuzu aggregator.
	function sendAllBalanceToYuzuAggregator() external {
		address payable yuzuAggregator_ = _getDEDUStorage().yuzuAggregator;
		require(yuzuAggregator_ != address(0), "DEDU: yuzuAggregator not set");

		uint256 balance = address(this).balance;
		(bool success, ) = yuzuAggregator_.call{value: balance}("");
		require(success, "DEDU: transfer to yuzuAggregator failed");
	}

	/// @notice Allows direct deposits of native tokens.
	receive() external payable {
		_stakeEDU(msg.sender);
	}

	// ----------------------------------
	// INTERNAL FUNCTIONS
	// ----------------------------------

	/// @dev Stakes native tokens with the Yuzu aggregator and mints DEDU tokens.
	function _stakeEDU(address depositor) internal {
		address payable stakingRewardsCollector_ = _getDEDUStorage()
			.yuzuAggregator;
		require(
			stakingRewardsCollector_ != address(0),
			"DEDU: yuzuAggregator not set"
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
		return _getDEDUStorage().yuzuAggregator;
	}

	/// @notice Returns the router address used to source the WEDU token.
	function routerAddress() external view returns (address) {
		return _getDEDUStorage().router;
	}

	/// @notice Returns the total pending withdrawals.
	function pendingWithdrawals() external view returns (uint256) {
		return _getDEDUStorage().pendingWithdrawals;
	}

	/// @notice Returns a user's pending withdrawals.
	function userPendingWithdrawals(
		address user
	) external view returns (UserWithdrawal memory) {
		return _getDEDUStorage().withdrawals[user];
	}
}
