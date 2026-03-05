// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IStaking {
	/*//////////////////////////////////////////////////////////////
                                ERRORS
//////////////////////////////////////////////////////////////*/
	error PairNotFound();
	error ZeroAmount();
	error InvalidToken();
	error SlippageTooHigh();
	error InvalidInputLengths();
	error UnauthorizedGToken();
	error InvalidPair();
	error InvalidPath();
	error InsufficientLiquidity();
	error InvalidSwapAmount();
	error ZeroRecipient();

	/*//////////////////////////////////////////////////////////////
                                EVENTS
//////////////////////////////////////////////////////////////*/

	/// @notice Emitted when liquidity is staked and GToken is minted
	event LiquidityStaked(
		address indexed user,
		address indexed pair,
		uint256 liquidity,
		uint256 workValue,
		uint256 epochsLocked,
		uint256 nonce
	);

	/// @notice Emitted when liquidity is unstaked
	event LiquidityUnstaked(
		address indexed user,
		address indexed pair,
		uint256 liquidityReturned,
		uint256 amount0,
		uint256 amount1
	);

	/// @notice Emitted when early unlock penalty is applied
	event EarlyUnlockPenalty(
		address indexed user,
		address indexed pair,
		uint256 liquidityBurned
	);

	/// @notice Emitted when single-sided liquidity is zapped
	event SingleSidedLiquidityAdded(
		address indexed user,
		address indexed pair,
		address indexed inputToken,
		uint256 amountIn,
		uint256 liquidityMinted
	);

	/// @notice Emitted when protocol collects LP fees from penalties
	event ProtocolLiquidityFeeCollected(
		address indexed pair,
		uint256 liquidityAmount
	);

	/*//////////////////////////////////////////////////////////////
	                            STAKING
	//////////////////////////////////////////////////////////////*/

	/// @notice Stake token-token liquidity
	function stakeTokensLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address[] calldata pathToDEDU,
		address to,
		uint256 epochsLocked
	) external;

	/// @notice Stake already minted LP tokens
	function stakeLiquidityIn(
		address pair,
		uint256 liquidity,
		address[] calldata pathToDEDU,
		address to,
		uint256 epochsLocked
	) external;

	/*//////////////////////////////////////////////////////////////
	                SINGLE-SIDED LIQUIDITY
	//////////////////////////////////////////////////////////////*/

	/// @notice Single-sided token → LP staking
	function stakeTokenLiquidityIn(
		address pair,
		address tokenA,
		uint256 tokenATotalAmount,
		uint256 tokenAMin,
		uint256 tokenBMin,
		address[] calldata pathToDEDU,
		address to,
		uint256 epochsLocked
	) external;

	/*//////////////////////////////////////////////////////////////
	                            UNSTAKING
	//////////////////////////////////////////////////////////////*/

	/// @notice Unstake LP positions using GToken nonces
	function unStake(
		address to,
		uint256[] calldata nonces,
		uint256[] calldata amounts0Min,
		uint256[] calldata amounts1Min
	) external;

	/*//////////////////////////////////////////////////////////////
	                            VIEWS
	//////////////////////////////////////////////////////////////*/

	/// @notice Preview liquidity returned after early unlock penalty
	function getLiquidityAfterPenalty(
		uint256[] calldata nonces,
		uint256[] calldata amounts0Min,
		uint256[] calldata amounts1Min
	)
		external
		view
		returns (
			uint256[] memory liquidities,
			uint256[] memory adjusted0Min,
			uint256[] memory adjusted1Min
		);

	function rewards() external view returns (address);

	function workToken() external view returns (address);

	function gToken() external view returns (address);

	function dEDU() external view returns (address);

	function WEDU() external view returns (address);
}
