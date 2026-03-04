// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV2Factory} from "../uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";

import {WorkitGToken} from "./WorkitGToken.sol";
import {WorkitToken} from "./WorkitToken.sol";

/// @title WorkitLaunchpad
/// @notice Bootstraps WORKIT liquidity before DEX listing and mints GToken liquidity receipts.
contract WorkitLaunchpad is AccessControl, ReentrancyGuard {
	using SafeERC20 for IERC20;
	using SafeERC20 for WorkitToken;

	bytes32 public constant LAUNCH_MANAGER_ROLE = keccak256("LAUNCH_MANAGER_ROLE");

	struct Campaign {
		address quoteToken;
		uint256 targetWorkit;
		uint256 targetQuote;
		uint256 totalWorkitDeposited;
		uint256 totalQuoteDeposited;
		uint256 workitUsed;
		uint256 quoteUsed;
		uint256 lpMinted;
		address lpToken;
		address lpRecipient;
		uint256 chainId;
		uint64 startTimestamp;
		uint64 endTimestamp;
		bool lockLp;
		bool liquidityAdded;
		bool finalized;
	}

	WorkitToken public immutable workitToken;
	WorkitGToken public immutable gToken;
	IUniswapV2Factory public immutable factory;
	IUniswapV2Router public immutable router;

	uint256 public campaignCount;
	mapping(uint256 => Campaign) public campaigns;
	mapping(uint256 => mapping(address => uint256)) public workitDeposits;
	mapping(uint256 => mapping(address => uint256)) public quoteDeposits;
	mapping(uint256 => address[]) private _campaignParticipants;
	mapping(uint256 => mapping(address => bool)) private _isParticipant;

	error ZeroAddress();
	error ZeroAmount();
	error InvalidTimeRange(uint64 startTimestamp, uint64 endTimestamp);
	error CampaignNotFound(uint256 campaignId);
	error CampaignNotActive(uint256 campaignId);
	error CampaignNotReady(uint256 campaignId);
	error CampaignAlreadyFinalized(uint256 campaignId);
	error CampaignAlreadyHasLiquidity(uint256 campaignId);
	error InsufficientCampaignDeposits(uint256 campaignId);
	error LpTokenMissing(uint256 campaignId);

	event CampaignCreated(
		uint256 indexed campaignId,
		address indexed quoteToken,
		uint256 targetWorkit,
		uint256 targetQuote,
		uint64 startTimestamp,
		uint64 endTimestamp
	);
	event WorkitDeposited(uint256 indexed campaignId, address indexed user, uint256 amount);
	event QuoteDeposited(uint256 indexed campaignId, address indexed user, uint256 amount);
	event LiquidityCreated(
		uint256 indexed campaignId,
		address indexed lpToken,
		uint256 workitUsed,
		uint256 quoteUsed,
		uint256 liquidityMinted
	);
	event LpDistributed(uint256 indexed campaignId, address indexed recipient, uint256 amount);
	event CampaignFinalized(uint256 indexed campaignId, bool lpLocked);

	constructor(
		address admin,
		WorkitToken workitToken_,
		WorkitGToken gToken_,
		IUniswapV2Factory factory_,
		IUniswapV2Router router_
	) {
		if (
			admin == address(0) ||
			address(workitToken_) == address(0) ||
			address(gToken_) == address(0) ||
			address(factory_) == address(0) ||
			address(router_) == address(0)
		) revert ZeroAddress();

		workitToken = workitToken_;
		gToken = gToken_;
		factory = factory_;
		router = router_;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(LAUNCH_MANAGER_ROLE, admin);
	}

	/// @notice Creates a new launch campaign.
	function createCampaign(
		address quoteToken,
		uint256 targetWorkit,
		uint256 targetQuote,
		uint64 startTimestamp,
		uint64 endTimestamp,
		bool lockLp,
		address lpRecipient,
		uint256 chainId
	) external onlyRole(LAUNCH_MANAGER_ROLE) returns (uint256 campaignId) {
		if (quoteToken == address(0) || lpRecipient == address(0)) revert ZeroAddress();
		if (targetWorkit == 0 || targetQuote == 0) revert ZeroAmount();
		if (startTimestamp >= endTimestamp) {
			revert InvalidTimeRange(startTimestamp, endTimestamp);
		}

		campaignId = ++campaignCount;
		Campaign storage campaign = campaigns[campaignId];
		campaign.quoteToken = quoteToken;
		campaign.targetWorkit = targetWorkit;
		campaign.targetQuote = targetQuote;
		campaign.lpRecipient = lpRecipient;
		campaign.chainId = chainId;
		campaign.startTimestamp = startTimestamp;
		campaign.endTimestamp = endTimestamp;
		campaign.lockLp = lockLp;

		emit CampaignCreated(
			campaignId,
			quoteToken,
			targetWorkit,
			targetQuote,
			startTimestamp,
			endTimestamp
		);
	}

	/// @notice Deposits WORKIT into campaign.
	function depositWorkit(uint256 campaignId, uint256 amount) external nonReentrant {
		if (amount == 0) revert ZeroAmount();
		Campaign storage campaign = _activeCampaign(campaignId);

		workitToken.safeTransferFrom(msg.sender, address(this), amount);
		campaign.totalWorkitDeposited += amount;
		workitDeposits[campaignId][msg.sender] += amount;
		_trackParticipant(campaignId, msg.sender);

		emit WorkitDeposited(campaignId, msg.sender, amount);
	}

	/// @notice Deposits quote token into campaign.
	function depositQuote(uint256 campaignId, uint256 amount) external nonReentrant {
		if (amount == 0) revert ZeroAmount();
		Campaign storage campaign = _activeCampaign(campaignId);

		IERC20(campaign.quoteToken).safeTransferFrom(msg.sender, address(this), amount);
		campaign.totalQuoteDeposited += amount;
		quoteDeposits[campaignId][msg.sender] += amount;
		_trackParticipant(campaignId, msg.sender);

		emit QuoteDeposited(campaignId, msg.sender, amount);
	}

	/// @notice Adds liquidity for a campaign once targets are met.
	function addLiquidity(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin,
		uint256 deadline
	)
		public
		nonReentrant
		onlyRole(LAUNCH_MANAGER_ROLE)
		returns (uint256 workitUsed, uint256 quoteUsed, uint256 liquidity)
	{
		Campaign storage campaign = campaigns[campaignId];
		if (campaign.quoteToken == address(0)) revert CampaignNotFound(campaignId);
		if (campaign.finalized) revert CampaignAlreadyFinalized(campaignId);
		if (campaign.liquidityAdded) revert CampaignAlreadyHasLiquidity(campaignId);
		if (
			campaign.totalWorkitDeposited < campaign.targetWorkit ||
			campaign.totalQuoteDeposited < campaign.targetQuote
		) {
			revert InsufficientCampaignDeposits(campaignId);
		}

		address lpToken = factory.getPair(address(workitToken), campaign.quoteToken);
		if (lpToken == address(0)) {
			lpToken = factory.createPair(address(workitToken), campaign.quoteToken);
		}

		workitToken.approve(address(router), campaign.totalWorkitDeposited);
		IERC20(campaign.quoteToken).forceApprove(address(router), campaign.totalQuoteDeposited);

		(workitUsed, quoteUsed, liquidity) = router.addLiquidity(
			address(workitToken),
			campaign.quoteToken,
			campaign.totalWorkitDeposited,
			campaign.totalQuoteDeposited,
			workitMin,
			quoteMin,
			address(this),
			deadline
		);

		campaign.workitUsed = workitUsed;
		campaign.quoteUsed = quoteUsed;
		campaign.lpMinted = liquidity;
		campaign.lpToken = lpToken;
		campaign.liquidityAdded = true;

		emit LiquidityCreated(campaignId, lpToken, workitUsed, quoteUsed, liquidity);
	}

	/// @notice Finalizes campaign, distributes/locks LP and mints GToken receipts.
	function finalizeLaunch(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin,
		uint256 deadline
	) external onlyRole(LAUNCH_MANAGER_ROLE) {
		Campaign storage campaign = campaigns[campaignId];
		if (campaign.quoteToken == address(0)) revert CampaignNotFound(campaignId);
		if (campaign.finalized) revert CampaignAlreadyFinalized(campaignId);

		bool ended = block.timestamp >= campaign.endTimestamp;
		bool targetsReached =
			campaign.totalWorkitDeposited >= campaign.targetWorkit &&
			campaign.totalQuoteDeposited >= campaign.targetQuote;
		if (!ended && !targetsReached) revert CampaignNotReady(campaignId);

		if (!campaign.liquidityAdded) {
			addLiquidity(campaignId, workitMin, quoteMin, deadline);
		}

		_mintGTokenReceipts(campaignId);
		_lockOrDistributeLP(campaignId);

		campaign.finalized = true;
		emit CampaignFinalized(campaignId, campaign.lockLp);
	}

	/// @notice Exposes LP settlement stage for manager operations.
	function lockOrDistributeLP(uint256 campaignId) external onlyRole(LAUNCH_MANAGER_ROLE) {
		_lockOrDistributeLP(campaignId);
	}

	function participants(uint256 campaignId) external view returns (address[] memory) {
		return _campaignParticipants[campaignId];
	}

	function _activeCampaign(uint256 campaignId) internal view returns (Campaign storage campaign) {
		campaign = campaigns[campaignId];
		if (campaign.quoteToken == address(0)) revert CampaignNotFound(campaignId);
		if (campaign.finalized) revert CampaignAlreadyFinalized(campaignId);
		if (block.timestamp < campaign.startTimestamp || block.timestamp > campaign.endTimestamp) {
			revert CampaignNotActive(campaignId);
		}
	}

	function _trackParticipant(uint256 campaignId, address participant) internal {
		if (_isParticipant[campaignId][participant]) return;
		_isParticipant[campaignId][participant] = true;
		_campaignParticipants[campaignId].push(participant);
	}

	function _mintGTokenReceipts(uint256 campaignId) internal {
		Campaign storage campaign = campaigns[campaignId];
		if (campaign.totalWorkitDeposited == 0 || campaign.lpToken == address(0)) {
			revert InsufficientCampaignDeposits(campaignId);
		}

		address[] storage campaignUsers = _campaignParticipants[campaignId];
		for (uint256 i = 0; i < campaignUsers.length; i++) {
			address user = campaignUsers[i];
			uint256 userWorkit = workitDeposits[campaignId][user];
			if (userWorkit == 0) continue;

			uint256 mintAmount = (campaign.workitUsed * userWorkit) /
				campaign.totalWorkitDeposited;
			if (mintAmount == 0) continue;

			gToken.mintForLiquidity(
				user,
				campaign.lpToken,
				campaign.chainId,
				campaignId,
				mintAmount
			);
		}
	}

	function _lockOrDistributeLP(uint256 campaignId) internal {
		Campaign storage campaign = campaigns[campaignId];
		if (!campaign.liquidityAdded) revert CampaignNotReady(campaignId);
		if (campaign.lpToken == address(0)) revert LpTokenMissing(campaignId);
		if (campaign.lockLp || campaign.lpMinted == 0) return;

		uint256 amount = campaign.lpMinted;
		campaign.lpMinted = 0;
		IERC20(campaign.lpToken).safeTransfer(campaign.lpRecipient, amount);
		emit LpDistributed(campaignId, campaign.lpRecipient, amount);
	}
}
