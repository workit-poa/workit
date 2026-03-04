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
		uint256 dhbarValue,
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

	/// @notice Stake HBAR + token liquidity
	function stakeHBARLiquidity(
		address token,
		uint256 tokenAmountDesired,
		uint256 tokenAmountMin,
		uint256 dHBARMin,
		address to,
		uint256 epochsLocked
	) external payable;

	/// @notice Stake WHBAR + token liquidity
	function stakeWHBARLiquidity(
		address token,
		uint256 whbarAmount,
		uint256 tokenAmountDesired,
		uint256 tokenAmountMin,
		uint256 dHBARMin,
		address to,
		uint256 epochsLocked
	) external;

	/// @notice Stake token-token liquidity
	function stakeTokensLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address[] calldata pathToDHBAR,
		address to,
		uint256 epochsLocked
	) external;

	/// @notice Stake already minted LP tokens
	function stakeLiquidityIn(
		address pair,
		uint256 liquidity,
		address[] calldata pathToDHBAR,
		address to,
		uint256 epochsLocked
	) external;

	/*//////////////////////////////////////////////////////////////
	                SINGLE-SIDED LIQUIDITY
	//////////////////////////////////////////////////////////////*/

	/// @notice Single-sided HBAR → LP staking
	function stakeHBARLiquidityIn(
		address pair,
		uint256 dHBARMin,
		uint256 tokenMin,
		address to,
		uint256 epochsLocked
	) external payable;

	/// @notice Single-sided WHBAR → LP staking
	function stakeWHBARLiquidityIn(
		address pair,
		uint256 whbarAmount,
		uint256 dHBARMin,
		uint256 tokenMin,
		address to,
		uint256 epochsLocked
	) external;

	/// @notice Single-sided token → LP staking
	function stakeTokenLiquidityIn(
		address pair,
		address tokenA,
		uint256 tokenATotalAmount,
		uint256 tokenAMin,
		uint256 tokenBMin,
		address[] calldata pathToDHBAR,
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

	/*//////////////////////////////////////////////////////////////
	                            ORACLE
	//////////////////////////////////////////////////////////////*/

	/// @notice Updates oracle contract address
	function setOracle(address oracle) external;

	/// @notice Updates TWAP oracle for a pair
	function pokeOracle(address pair) external;

	function oracle() external returns (address);

	function rewards() external returns (address);

	function dHBAR() external view returns (address);

	function WHBAR() external view returns (address);
}
