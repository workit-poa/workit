// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IGToken} from "../tokens/GToken/IGToken.sol";
import {ICampaign} from "./ICampaign.sol";

interface ILaunchpad {
	error InvalidAddress(address addr);
	error OnlyCampaigns(address caller);
	error NotCampaignMigrator(address caller, address migrator);
	error PairAlreadyDeployed(address campaign, address pair);
	error PairDeploymentFailed(address token0, address token1);
	error ZeroMigrator(address migrator);
	error ZeroCampaignToken(address token);
	error ZeroCampaignTokenSupply(uint256 supply);
	error FundingTokenNotAllowed(address token);
	error NoFundingPathToDHBAR(address token);
	error InsufficientGoalDHBAR(uint256 goalDHBARValue, uint256 required);
	error InvalidDeadline(uint256 deadline, uint256 currentTime);
	error InvalidDuration(
		uint256 duration,
		uint256 minDuration,
		uint256 maxDuration
	);
	error InvalidLockEpochs(
		uint256 lockEpochs,
		uint256 minEpochs,
		uint256 maxEpochs
	);
	error PoolOrCampaignExists(
		address fundingToken,
		address campaignToken,
		address pair,
		address campaign
	);
	error NoSecurityTokens();
	error ZeroGTokenBalance(uint256 nonce);
	error SecurityGTokenExpired(
		uint256 nonce,
		uint256 epochsLeft,
		uint256 minEpochs
	);
	error GTokenNotSecurityDeposit(uint256 nonce, address requiredToken);
	error NotEnoughGTokenAmount(uint256 totalAmount, uint256 requiredAmount);
	error ZeroFundingToken(address token);
	error EmptyPath();
	error SinglePathMustBeDHBAR(address providedToken, address deduToken);
	error InvalidOutputToken(address outputToken, address deduToken);
	error PairDoesNotExist(address tokenA, address tokenB);
	error ZeroToken(address token);
	error TokenNotAllowed(address token);
	error NoSecurityGTokens(address campaign);

	function mint(address to, uint256 amount) external;

	function burn(address from, uint256 amount) external;

	function deployPair() external;

	function createCampaign(
		ICampaign.Listing memory listing,
		uint256[] calldata securityNonces,
		uint256 campaignTokenSupply
	) external;

	function migrateCampaign(
		address creator,
		ICampaign.Listing memory listing,
		ICampaign.Status status,
		uint256 pendingContribution
	) external;

	function getSecurityGTokens(
		address
	) external view returns (IGToken.Balance[] memory);

	function returnSecurityGTokens(address to) external;

	function dHBAR() external view returns (address);

	function WHBAR() external view returns (address);

	function campaignPair(address) external view returns (address);

	function tokenBalance(uint256 id) external view returns (uint256);

	function name() external view returns (string memory);

	function symbol() external view returns (string memory);

	function decimals() external view returns (uint8);
}
