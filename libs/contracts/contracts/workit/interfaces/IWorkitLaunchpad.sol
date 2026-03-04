// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWorkitLaunchpad {
	function setQuoteTokenAllowed(address quoteToken, bool allowed) external;

	function approveCampaign(uint256 campaignId) external;

	function governanceFinalizeCampaign(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin
	) external;
}
