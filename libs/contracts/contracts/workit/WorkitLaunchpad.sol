// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV2Factory} from "../gainzswap/uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {FullMath} from "../gainzswap/uniswap-v2/libraries/FullMath.sol";

import {IWorkitGToken} from "./interfaces/IWorkitGToken.sol";
import {IWorkitStaking} from "./interfaces/IWorkitStaking.sol";
import {IWorkitLaunchpad} from "./interfaces/IWorkitLaunchpad.sol";
import {IWorkitDexRouter} from "./interfaces/IWorkitDexRouter.sol";

contract WorkitLaunchpad is AccessControl, ReentrancyGuard, IWorkitLaunchpad {
	using SafeERC20 for IERC20;

	bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
	bytes32 public constant FINALIZER_ROLE = keccak256("FINALIZER_ROLE");

	enum CampaignStatus {
		Funding,
		Approved,
		Finalized,
		Cancelled
	}

	struct Campaign {
		address creator;
		address quoteToken;
		uint256 workitGoal;
		uint256 quoteGoal;
		uint256 workitDeposited;
		uint256 quoteDeposited;
		uint256 workitUsed;
		uint256 quoteUsed;
		uint64 deadline;
		address pool;
		uint256 gTokenId;
		uint256 liquidity;
		CampaignStatus status;
	}

	struct Deposit {
		uint256 workitAmount;
		uint256 quoteAmount;
		bool claimed;
	}

	IERC20 public immutable workit;
	IWorkitDexRouter public immutable router;
	IUniswapV2Factory public immutable factory;
	IWorkitGToken public immutable gToken;
	IWorkitStaking public immutable staking;

	uint256 public nextCampaignId;

	mapping(uint256 => Campaign) public campaigns;
	mapping(uint256 => mapping(address => Deposit)) public campaignDeposits;
	mapping(address => bool) public allowedQuoteTokens;

	event QuoteTokenAllowed(address indexed quoteToken, bool allowed);
	event CampaignCreated(
		uint256 indexed campaignId,
		address indexed creator,
		address indexed quoteToken,
		uint256 workitGoal,
		uint256 quoteGoal,
		uint64 deadline
	);
	event CampaignDeposit(
		uint256 indexed campaignId,
		address indexed user,
		uint256 workitAmount,
		uint256 quoteAmount
	);
	event CampaignApproved(uint256 indexed campaignId, address indexed approver);
	event PoolCreated(
		uint256 indexed campaignId,
		address indexed pool,
		address indexed quoteToken
	);
	event LiquidityAdded(
		uint256 indexed campaignId,
		address indexed pool,
		uint256 workitUsed,
		uint256 quoteUsed,
		uint256 liquidity
	);
	event CampaignFinalized(
		uint256 indexed campaignId,
		address indexed pool,
		uint256 indexed gTokenId,
		uint256 liquidity
	);
	event CampaignClaimed(
		uint256 indexed campaignId,
		address indexed user,
		uint256 gTokenAmount,
		uint256 workitRefund,
		uint256 quoteRefund
	);

	error ZeroAddress();
	error InvalidDeadline(uint256 deadline, uint256 currentTimestamp);
	error QuoteTokenNotAllowed(address quoteToken);
	error InvalidCampaign(uint256 campaignId);
	error InvalidCampaignStatus(CampaignStatus expected, CampaignStatus actual);
	error CampaignClosed(uint256 deadline, uint256 currentTimestamp);
	error EmptyDeposit();
	error CampaignGoalNotMet(
		uint256 workitDeposited,
		uint256 quoteDeposited,
		uint256 workitGoal,
		uint256 quoteGoal
	);
	error InvalidClaim();

	constructor(
		address admin,
		address workit_,
		address router_,
		address gToken_,
		address staking_
	) {
		if (
			admin == address(0) ||
			workit_ == address(0) ||
			router_ == address(0) ||
			gToken_ == address(0) ||
			staking_ == address(0)
		) {
			revert ZeroAddress();
		}

		workit = IERC20(workit_);
		router = IWorkitDexRouter(router_);
		factory = IUniswapV2Factory(IWorkitDexRouter(router_).factory());
		gToken = IWorkitGToken(gToken_);
		staking = IWorkitStaking(staking_);

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(GOVERNANCE_ROLE, admin);
		_grantRole(FINALIZER_ROLE, admin);
	}

	function setQuoteTokenAllowed(
		address quoteToken,
		bool allowed
	) external override onlyRole(GOVERNANCE_ROLE) {
		if (quoteToken == address(0)) revert ZeroAddress();

		allowedQuoteTokens[quoteToken] = allowed;
		emit QuoteTokenAllowed(quoteToken, allowed);
	}

	function createCampaign(
		address quoteToken,
		uint256 workitGoal,
		uint256 quoteGoal,
		uint64 deadline
	) external returns (uint256 campaignId) {
		if (quoteToken == address(0)) revert ZeroAddress();
		if (!allowedQuoteTokens[quoteToken]) revert QuoteTokenNotAllowed(quoteToken);
		if (deadline <= block.timestamp) {
			revert InvalidDeadline(deadline, block.timestamp);
		}
		if (workitGoal == 0 || quoteGoal == 0) revert EmptyDeposit();

		campaignId = ++nextCampaignId;
		campaigns[campaignId] = Campaign({
			creator: msg.sender,
			quoteToken: quoteToken,
			workitGoal: workitGoal,
			quoteGoal: quoteGoal,
			workitDeposited: 0,
			quoteDeposited: 0,
			workitUsed: 0,
			quoteUsed: 0,
			deadline: deadline,
			pool: address(0),
			gTokenId: 0,
			liquidity: 0,
			status: CampaignStatus.Funding
		});

		emit CampaignCreated(
			campaignId,
			msg.sender,
			quoteToken,
			workitGoal,
			quoteGoal,
			deadline
		);
	}

	function deposit(
		uint256 campaignId,
		uint256 workitAmount,
		uint256 quoteAmount
	) external nonReentrant {
		Campaign storage campaign = _campaign(campaignId);
		if (
			campaign.status != CampaignStatus.Funding &&
			campaign.status != CampaignStatus.Approved
		) {
			revert InvalidCampaignStatus(CampaignStatus.Funding, campaign.status);
		}
		if (block.timestamp > campaign.deadline) {
			revert CampaignClosed(campaign.deadline, block.timestamp);
		}
		if (workitAmount == 0 && quoteAmount == 0) revert EmptyDeposit();

		Deposit storage userDeposit = campaignDeposits[campaignId][msg.sender];
		if (workitAmount > 0) {
			workit.safeTransferFrom(msg.sender, address(this), workitAmount);
			campaign.workitDeposited += workitAmount;
			userDeposit.workitAmount += workitAmount;
		}
		if (quoteAmount > 0) {
			IERC20(campaign.quoteToken).safeTransferFrom(
				msg.sender,
				address(this),
				quoteAmount
			);
			campaign.quoteDeposited += quoteAmount;
			userDeposit.quoteAmount += quoteAmount;
		}

		emit CampaignDeposit(campaignId, msg.sender, workitAmount, quoteAmount);
	}

	function approveCampaign(
		uint256 campaignId
	) external override onlyRole(GOVERNANCE_ROLE) {
		Campaign storage campaign = _campaign(campaignId);
		if (campaign.status != CampaignStatus.Funding) {
			revert InvalidCampaignStatus(CampaignStatus.Funding, campaign.status);
		}

		campaign.status = CampaignStatus.Approved;
		emit CampaignApproved(campaignId, msg.sender);
	}

	function governanceFinalizeCampaign(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin
	) external override onlyRole(GOVERNANCE_ROLE) {
		Campaign storage campaign = _campaign(campaignId);
		if (campaign.status == CampaignStatus.Funding) {
			campaign.status = CampaignStatus.Approved;
			emit CampaignApproved(campaignId, msg.sender);
		}

		_finalizeCampaign(campaignId, workitMin, quoteMin);
	}

	function finalizeCampaign(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin
	) external onlyRole(FINALIZER_ROLE) {
		_finalizeCampaign(campaignId, workitMin, quoteMin);
	}

	function claim(
		uint256 campaignId,
		address to
	)
		external
		nonReentrant
		returns (uint256 gTokenAmount, uint256 workitRefund, uint256 quoteRefund)
	{
		if (to == address(0)) revert ZeroAddress();

		Campaign storage campaign = _campaign(campaignId);
		if (campaign.status != CampaignStatus.Finalized) {
			revert InvalidCampaignStatus(CampaignStatus.Finalized, campaign.status);
		}

		Deposit storage userDeposit = campaignDeposits[campaignId][msg.sender];
		if (userDeposit.claimed) revert InvalidClaim();
		if (userDeposit.workitAmount == 0 && userDeposit.quoteAmount == 0) {
			revert InvalidClaim();
		}
		userDeposit.claimed = true;

		uint256 workitUsedByUser = campaign.workitDeposited == 0
			? 0
			: FullMath.mulDiv(
				userDeposit.workitAmount,
				campaign.workitUsed,
				campaign.workitDeposited
			);
		uint256 quoteUsedByUser = campaign.quoteDeposited == 0
			? 0
			: FullMath.mulDiv(
				userDeposit.quoteAmount,
				campaign.quoteUsed,
				campaign.quoteDeposited
			);

		gTokenAmount = workitUsedByUser;
		if (gTokenAmount > 0) {
			gToken.mintListing(to, campaign.pool, gTokenAmount);
		}

		workitRefund = userDeposit.workitAmount - workitUsedByUser;
		quoteRefund = userDeposit.quoteAmount - quoteUsedByUser;

		if (workitRefund > 0) {
			workit.safeTransfer(to, workitRefund);
		}
		if (quoteRefund > 0) {
			IERC20(campaign.quoteToken).safeTransfer(to, quoteRefund);
		}

		emit CampaignClaimed(
			campaignId,
			msg.sender,
			gTokenAmount,
			workitRefund,
			quoteRefund
		);
	}

	function lpBalance(uint256 campaignId) external view returns (uint256) {
		Campaign storage campaign = campaigns[campaignId];
		if (campaign.pool == address(0)) return 0;
		return IERC20(campaign.pool).balanceOf(address(this));
	}

	function _campaign(
		uint256 campaignId
	) private view returns (Campaign storage campaign) {
		campaign = campaigns[campaignId];
		if (campaign.creator == address(0)) revert InvalidCampaign(campaignId);
	}

	function _finalizeCampaign(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin
	) private nonReentrant {
		Campaign storage campaign = _campaign(campaignId);
		if (campaign.status != CampaignStatus.Approved) {
			revert InvalidCampaignStatus(CampaignStatus.Approved, campaign.status);
		}
		if (campaign.workitDeposited < campaign.workitGoal || campaign.quoteDeposited < campaign.quoteGoal) {
			revert CampaignGoalNotMet(
				campaign.workitDeposited,
				campaign.quoteDeposited,
				campaign.workitGoal,
				campaign.quoteGoal
			);
		}

		address pool = factory.getPair(address(workit), campaign.quoteToken);
		if (pool == address(0)) {
			factory.createPair(address(workit), campaign.quoteToken);
			pool = factory.getPair(address(workit), campaign.quoteToken);
			emit PoolCreated(campaignId, pool, campaign.quoteToken);
		}

		workit.forceApprove(address(router), campaign.workitDeposited);
		IERC20(campaign.quoteToken).forceApprove(address(router), campaign.quoteDeposited);

		(uint256 workitUsed, uint256 quoteUsed, uint256 liquidity) = router.addLiquidity(
			address(workit),
			campaign.quoteToken,
			campaign.workitDeposited,
			campaign.quoteDeposited,
			workitMin,
			quoteMin,
			address(this),
			block.timestamp
		);
		require(pool != address(0) && liquidity > 0, "WORKIT_LAUNCHPAD: NO_LIQUIDITY");

		uint256 gTokenId = gToken.registerListingPool(pool, campaign.quoteToken, campaignId);

		campaign.pool = pool;
		campaign.workitUsed = workitUsed;
		campaign.quoteUsed = quoteUsed;
		campaign.liquidity = liquidity;
		campaign.gTokenId = gTokenId;
		campaign.status = CampaignStatus.Finalized;

		staking.enableListingPool(pool);

		emit LiquidityAdded(campaignId, pool, workitUsed, quoteUsed, liquidity);
		emit CampaignFinalized(campaignId, pool, gTokenId, liquidity);
	}
}
