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
	error MissingCampaignTokens(uint256 campaignSupply);
	error ZeroAddress(address addr);
	error InvalidFinalStatus(Status status);
	error InvalidListingGTokenNonce(uint256 nonce);
	error UnauthorizedGToken();
	error MergeFailed();
	error TokenAssociationFailed(address token, uint256 responseCode);
	error WrappedNativeDepositFailed(address token, uint256 value);

	/*//////////////////////////////////////////////////////////////
	                           EVENTS
	//////////////////////////////////////////////////////////////*/

	event ContributionMade(address indexed contributor, uint256 amount);

	/*//////////////////////////////////////////////////////////////
	                       CONTRIBUTIONS
	//////////////////////////////////////////////////////////////*/

	/// @notice ERC20 contribution
	function contribute(uint256 amount, address to) external;

	/// @notice Native HBAR contribution for campaigns funded in wrapped HBAR.
	/// @dev Internally wraps HBAR into the configured funding token and mints claim units from received wrapped balance.
	function contributeHbar(address to) external payable;

	/*//////////////////////////////////////////////////////////////
	                      CAMPAIGN ACTIONS
	//////////////////////////////////////////////////////////////*/

	/// @notice Deploy campaign liquidity after funding completes
	function deployLiquidity() external;

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
