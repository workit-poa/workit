// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IGovernance {
	struct MigrateLiqVar {
		uint256 removeAmount0Min;
		uint256 removeAmount1Min;
		uint256 addAmount0Min;
		uint256 addAmount1Min;
	}

	event PairLiqFeeMigrated(
		address indexed pair,
		uint256 liquidity,
		uint256 amount0,
		uint256 amount1
	);

	function initialize(address gainzToken, address wNativeToken) external;

	function initializeV2(address owner) external;

	function configure(
		address gToken,
		address launchPair,
		address router
	) external;

	function setStaking(address staking) external;

	function migratePairLiqFee(
		address pair,
		MigrateLiqVar memory migrateVar
	) external;

	function claimRewards(
		uint256[] memory nonces,
		MigrateLiqVar memory migrateVar,
		address[] calldata pathToDEDU
	) external returns (uint256[] memory);

	function unStake(
		uint256[] calldata nonces,
		uint256[] calldata amount0Mins,
		uint256[] calldata amount1Mins
	) external;

	function getLiquidityAfterPenalty(
		uint256[] memory nonces,
		uint256[] memory amounts0Min,
		uint256[] memory amounts1Min
	)
		external
		view
		returns (
			uint256[] memory liquidities,
			uint256[] memory adjusted0Min,
			uint256[] memory adjusted1Min
		);

	function getClaimableRewards(
		address user,
		uint256[] calldata nonces
	) external view returns (uint256 totalClaimable);
}
