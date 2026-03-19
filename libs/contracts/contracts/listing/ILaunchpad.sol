// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ICampaign} from "./ICampaign.sol";

interface ILaunchpad {
    error InvalidAddress(address addr);
    error InvalidCampaign(address campaign);
    error OnlyCampaigns(address caller);
    error PairNotDeployed(address campaign);
    error PairDeploymentFailed(address token0, address token1);
    error ZeroCampaignToken(address token);
    error ZeroCampaignTokenSupply(uint256 supply);
    error InvalidDeadline(uint256 deadline, uint256 currentTime);
    error InvalidDuration(
        uint256 duration,
        uint256 minDuration,
        uint256 maxDuration
    );
    error ListingMustIncludeWorkToken(
        address fundingToken,
        address campaignToken,
        address workToken
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
    error TokenAssociationFailed(address token, uint256 responseCode);
    error InsufficientClaimBalance(
        address user,
        uint256 campaignId,
        uint256 balance,
        uint256 required
    );
    error UnauthorizedGToken(address sender, address expected);

    function mint(address to, uint256 amount) external;

    function burn(address from, uint256 amount) external;

    function deployPair(address campaign) external payable returns (address pair);

    function stakeCampaignPair() external;

    function createCampaign(
        ICampaign.Listing memory listing,
        uint256 campaignTokenSupply
    ) external;

    function workToken() external view returns (address);

    function staking() external view returns (address);

    function factory() external view returns (address);

    function campaignPair(address) external view returns (address);

    function tokenBalance(uint256 id) external view returns (uint256);
}
