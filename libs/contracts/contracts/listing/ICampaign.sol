// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IGToken} from "../tokens/GToken/IGToken.sol";

interface ICampaign {
	/*//////////////////////////////////////////////////////////////
	                           TYPES
	//////////////////////////////////////////////////////////////*/

	enum Status {
		Pending,
		Funding,
		Failed,
		Success
	}

	struct Listing {
		address campaignToken;
		address fundingToken;
		uint256 lockEpochs;
		uint256 goal;
		uint256 deadline;
	}

	error StatusUnchanged(Status status);
	error ZeroLaunchpad(address launchpad);
	error ZeroGToken(address gToken);
	error ZeroFundingToken(address token);
	error ZeroCampaignToken(address token);
	error ZeroGoal(uint256 goal);
	error IdenticalTokens(address tokenA, address tokenB);
	error CampaignExpired(uint256 deadline, uint256 currentTime);
	error InvalidStatus(Status expected, Status actual);
	error ZeroContribution(uint256 amount);
	error CampaignNotEnded(uint256 deadline, uint256 currentTime);
	error CampaignNotSuccess(Status status);
	error ContributionsDrained(uint256 contributionBalance);
	error NoLiquidity(uint256 amount);
	error CampaignSucceeded(uint256 fundingSupply, uint256 goal);
	error CampaignNotFailed(Status status);
	error GoalNotReached(uint256 goal, uint256 fundingSupply);
	error MissingCampaignTokens(uint256 securityCount, uint256 campaignSupply);
	error ZeroAddress(address addr);
	error CampaignNotExpired(uint256 deadline, uint256 currentTime);
	error NotAllowed(address caller, address launchpad, address migrator);
	error CampaignFundsFound(uint256 securityCount, uint256 campaignSupply);
	error InvalidFinalStatus(Status status);
	error UnauthorizedCaller(address caller, address expected);
	error PendingContributionZero(uint256 pendingContribution);
	error InvalidListingGTokenNonce(uint256 nonce);
	error UnauthorizedGToken();
	error InvalidGTokenSender();
	error MergeFailed();

	/*//////////////////////////////////////////////////////////////
	                           EVENTS
	//////////////////////////////////////////////////////////////*/

	event ContributionMade(address indexed contributor, uint256 amount);

	/*//////////////////////////////////////////////////////////////
	                         INITIALIZER
	//////////////////////////////////////////////////////////////*/

	function initialize(
		address launchpad_,
		address gToken_,
		Listing calldata listing_
	) external;

	/*//////////////////////////////////////////////////////////////
	                       CONTRIBUTIONS
	//////////////////////////////////////////////////////////////*/

	/// @notice ERC20 contribution
	function contribute(uint256 amount, address to) external;

	/*//////////////////////////////////////////////////////////////
	                      CAMPAIGN ACTIONS
	//////////////////////////////////////////////////////////////*/

	/// @notice Deploy liquidity pair after funding completes
	function deployPair() external;

	/// @notice Owner-driven resolution (normal path)
	function resolveCampaign(address to) external returns (Status);

	/// @notice Redeem claim token for liquidity after success
	function redeemContribution(
		uint256 contribution,
		address to
	) external returns (uint256 gTokenNonce, uint256 userLiqShare);

	/// @notice Refund contribution after failure
	function refundContribution(uint256 contribution, address to) external;

	/*//////////////////////////////////////////////////////////////
	                      VIEW FUNCTIONS
	//////////////////////////////////////////////////////////////*/

	function status() external view returns (Status);

	function listing() external view returns (Listing memory);

	function fundingSupply() external view returns (uint256);

	function campaignSupply() external view returns (uint256);
}
