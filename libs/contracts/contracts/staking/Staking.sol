// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";

import {IGToken} from "../tokens/GToken/IGToken.sol";
import {IRewards} from "./IRewards.sol";

import {Epochs} from "../libraries/Epochs.sol";
import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {UniswapV2LiquidityMathLibrary} from "../libraries/UniswapV2LiquidityMathLibrary.sol";
import {Math} from "../libraries/Math.sol";

import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";
import {IStaking} from "./IStaking.sol";

contract Staking is IStaking, Initializable, OwnableUpgradeable {
	using GTokenLib for IGToken.Attributes;
	using Epochs for Epochs.Storage;

	/*//////////////////////////////////////////////////////////////
	                            STORAGE
	//////////////////////////////////////////////////////////////*/
	/// @custom:storage-location erc7201:workit.contracts.staking.Staking
	struct StakingStorage {
		address factory;
		address router;
		address rewards;
		address workToken;
		address gToken;
		Epochs.Storage epochs;
		mapping(address => uint256) collectedPairLiqFees;
	}

	// keccak256("workit.contracts.staking.Staking") & ~bytes32(uint256(0xff))
	bytes32 internal constant STAKING_STORAGE_LOCATION =
		0x773a49547f02e2e52c5aae1b0d90edf09bb5da1b06a4edcd76d4bb3a0cff0c00;

	function _stakingStorage() private pure returns (StakingStorage storage $) {
		bytes32 slot = STAKING_STORAGE_LOCATION;
		assembly {
			$.slot := slot
		}
	}

	/*//////////////////////////////////////////////////////////////
	                         INITIALIZATION
	//////////////////////////////////////////////////////////////*/
	function initialize(
		address router,
		address rewards_,
		address workToken_,
		address gToken_
	) external initializer {
		if (router == address(0) || rewards_ == address(0)) revert ZeroAmount();
		if (workToken_ == address(0) || gToken_ == address(0)) revert InvalidToken();

		__Ownable_init(msg.sender);

		StakingStorage storage $ = _stakingStorage();
		$.router = router;
		$.factory = IUniswapV2Router(router).factory();
		$.rewards = rewards_;
		$.workToken = workToken_;
		$.gToken = gToken_;
		$.epochs = IGToken(gToken_).epochs();
	}

	/*//////////////////////////////////////////////////////////////
	                        INTERNAL HELPERS
	//////////////////////////////////////////////////////////////*/

	function _pullToken(address token, uint256 amount) internal {
		if (amount > 0) {
			IERC20(token).transferFrom(msg.sender, address(this), amount);
		}
	}

	function _requirePairContainsWork(
		address tokenA,
		address tokenB
	) internal view {
		address work = _stakingStorage().workToken;
		if (tokenA != work && tokenB != work) revert InvalidToken();
	}

	function _validatedPairTokens(
		address pair
	) internal view returns (address token0, address token1) {
		StakingStorage storage $ = _stakingStorage();
		token0 = IUniswapV2Pair(pair).token0();
		token1 = IUniswapV2Pair(pair).token1();

		address expectedPair = IUniswapV2Factory($.factory).getPair(token0, token1);
		if (expectedPair == address(0)) revert PairNotFound();
		if (expectedPair != pair) revert InvalidPair();

		_requirePairContainsWork(token0, token1);
	}

	function _wrkLiquidityValue(
		address pair,
		uint256 liquidity
	) internal view returns (uint256 value) {
		(address token0, address token1) = _validatedPairTokens(pair);
		(uint256 amount0, uint256 amount1) = UniswapV2LiquidityMathLibrary
			.getLiquidityValue(_stakingStorage().factory, token0, token1, liquidity);

		address work = _stakingStorage().workToken;
		value = token0 == work ? amount0 : amount1;
		if (value == 0) revert InsufficientLiquidity();
	}

	function _stakeLiquidity(
		IGToken.LiquidityInfo memory liqInfo,
		address to,
		uint256 epochsLocked
	) internal {
		if (to == address(0)) revert ZeroRecipient();

		(liqInfo.token0, liqInfo.token1) = _validatedPairTokens(liqInfo.pair);
		liqInfo.liqValue = _wrkLiquidityValue(liqInfo.pair, liqInfo.liquidity);

		uint256 nonce = IGToken(_stakingStorage().gToken).mintGToken(
			to,
			IRewards(_stakingStorage().rewards).rewardPerShare(),
			epochsLocked,
			liqInfo
		);

		emit LiquidityStaked(
			to,
			liqInfo.pair,
			liqInfo.liquidity,
			liqInfo.liqValue,
			epochsLocked,
			nonce
		);
	}

	function _addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin
	) internal returns (IGToken.LiquidityInfo memory liqInfo) {
		if (tokenA == tokenB) revert InvalidToken();
		_requirePairContainsWork(tokenA, tokenB);

		StakingStorage storage $ = _stakingStorage();
		liqInfo.pair = IUniswapV2Factory($.factory).getPair(tokenA, tokenB);
		if (liqInfo.pair == address(0)) revert PairNotFound();

		IERC20(tokenA).approve($.router, amountADesired);
		IERC20(tokenB).approve($.router, amountBDesired);

		(uint256 amountA, uint256 amountB, uint256 liquidity) = IUniswapV2Router($.router)
			.addLiquidity(
				tokenA,
				tokenB,
				amountADesired,
				amountBDesired,
				amountAMin,
				amountBMin,
				address(this),
				block.timestamp
			);

		liqInfo.liquidity = liquidity;

		if (amountADesired > amountA) {
			IERC20(tokenA).transfer(msg.sender, amountADesired - amountA);
		}
		if (amountBDesired > amountB) {
			IERC20(tokenB).transfer(msg.sender, amountBDesired - amountB);
		}
	}

	/*//////////////////////////////////////////////////////////////
	                            STAKING
	//////////////////////////////////////////////////////////////*/

	function stakeTokensLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address[] calldata,
		address to,
		uint256 epochsLocked
	) external override {
		_pullToken(tokenA, amountADesired);
		_pullToken(tokenB, amountBDesired);

		IGToken.LiquidityInfo memory liqInfo = _addLiquidity(
			tokenA,
			tokenB,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin
		);

		_stakeLiquidity(liqInfo, to, epochsLocked);
	}

	function stakeLiquidityIn(
		address pair,
		uint256 liquidity,
		address[] calldata,
		address to,
		uint256 epochsLocked
	) external override {
		if (liquidity == 0) revert ZeroAmount();
		_validatedPairTokens(pair);

		IUniswapV2Pair(pair).transferFrom(msg.sender, address(this), liquidity);

		IGToken.LiquidityInfo memory liqInfo;
		liqInfo.pair = pair;
		liqInfo.liquidity = liquidity;

		_stakeLiquidity(liqInfo, to, epochsLocked);
	}

	/*//////////////////////////////////////////////////////////////
	                SINGLE-SIDED LIQUIDITY ADD
	//////////////////////////////////////////////////////////////*/

	function _optimalSwapAmount(
		uint256 reserveIn,
		uint256 amountIn
	) internal pure returns (uint256) {
		if (amountIn == 0) revert ZeroAmount();
		if (reserveIn == 0) revert InsufficientLiquidity();

		return
			(Math.sqrt(reserveIn * (amountIn * 3988000 + reserveIn * 3988009)) -
				reserveIn *
				1997) / 1994;
	}

	function _optimalSwap(
		address tokenA,
		uint256 totalInA,
		uint256 minOutB,
		address pair
	)
		private
		returns (uint256 tokenAAmount, uint256 tokenBAmount, address tokenB)
	{
		if (totalInA == 0) revert ZeroAmount();

		address token0;
		address token1;
		(token0, token1) = _validatedPairTokens(pair);
		if (token0 != tokenA && token1 != tokenA) revert InvalidToken();

		(uint112 r0, uint112 r1, ) = IUniswapV2Pair(pair).getReserves();
		uint256 reserveIn;
		(reserveIn, tokenB) = tokenA == token0
			? (uint256(r0), token1)
			: (uint256(r1), token0);

		uint256 swapAmount = _optimalSwapAmount(reserveIn, totalInA);
		if (swapAmount >= totalInA) revert InvalidSwapAmount();

		tokenBAmount = _swapExactTokenForToken(
			tokenA,
			tokenB,
			swapAmount,
			minOutB
		);
		tokenAAmount = totalInA - swapAmount;
	}

	function _swapExactTokenForToken(
		address tokenIn,
		address tokenOut,
		uint256 amountIn,
		uint256 minOut
	) private returns (uint256 amountOut) {
		StakingStorage storage $ = _stakingStorage();
		IERC20(tokenIn).approve($.router, amountIn);

		address[] memory path = new address[](2);
		path[0] = tokenIn;
		path[1] = tokenOut;

		uint256[] memory amounts = IUniswapV2Router($.router).swapExactTokensForTokens(
			amountIn,
			minOut,
			path,
			address(this),
			block.timestamp
		);
		amountOut = amounts[1];
	}

	function stakeTokenLiquidityIn(
		address pair,
		address tokenA,
		uint256 tokenATotalAmount,
		uint256 tokenAMin,
		uint256 tokenBMin,
		address[] calldata,
		address to,
		uint256 epochsLocked
	) external override {
		if (tokenATotalAmount == 0) revert ZeroAmount();
		_pullToken(tokenA, tokenATotalAmount);

		(
			uint256 amountADesired,
			uint256 amountBDesired,
			address tokenB
		) = _optimalSwap(tokenA, tokenATotalAmount, tokenBMin, pair);

		IGToken.LiquidityInfo memory liqInfo = _addLiquidity(
			tokenA,
			tokenB,
			amountADesired,
			amountBDesired,
			tokenAMin,
			tokenBMin
		);

		_stakeLiquidity(liqInfo, to, epochsLocked);
		emit SingleSidedLiquidityAdded(
			msg.sender,
			pair,
			tokenA,
			tokenATotalAmount,
			amountADesired
		);
	}

	/*//////////////////////////////////////////////////////////////
	                           UNSTAKING
	//////////////////////////////////////////////////////////////*/

	function _computeEarlyUnlockPenalty(
		IGToken.Attributes memory attr,
		uint256 amount0Min,
		uint256 amount1Min
	)
		internal
		view
		returns (
			uint256 liquidityToReturn,
			uint256 amount0MinAdjusted,
			uint256 amount1MinAdjusted,
			uint256 liqFee
		)
	{
		StakingStorage storage $ = _stakingStorage();
		uint256 liquidity = attr.lpDetails.liquidity;

		liquidityToReturn = attr.epochsLocked == 0
			? liquidity
			: attr.valueToKeep(liquidity, $.epochs.currentEpoch());

		if (liquidityToReturn < liquidity) {
			liqFee = liquidity - liquidityToReturn;
			amount0MinAdjusted = (amount0Min * liquidityToReturn) / liquidity;
			amount1MinAdjusted = (amount1Min * liquidityToReturn) / liquidity;
		} else {
			amount0MinAdjusted = amount0Min;
			amount1MinAdjusted = amount1Min;
		}
	}

	function getLiquidityAfterPenalty(
		uint256[] calldata nonces,
		uint256[] calldata amounts0Min,
		uint256[] calldata amounts1Min
	)
		external
		view
		override
		returns (
			uint256[] memory liquidities,
			uint256[] memory adjusted0Min,
			uint256[] memory adjusted1Min
		)
	{
		if (
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) revert InvalidInputLengths();

		StakingStorage storage $ = _stakingStorage();
		IGToken gToken_ = IGToken($.gToken);

		liquidities = new uint256[](nonces.length);
		adjusted0Min = new uint256[](nonces.length);
		adjusted1Min = new uint256[](nonces.length);

		for (uint256 i; i < nonces.length; ++i) {
			IGToken.Attributes memory attr = gToken_.getAttributes(nonces[i]);
			(
				liquidities[i],
				adjusted0Min[i],
				adjusted1Min[i],
				/*liqFee*/
			) = _computeEarlyUnlockPenalty(attr, amounts0Min[i], amounts1Min[i]);
		}
	}

	function _removeLiquidity(
		IGToken.LiquidityInfo memory liqInfo,
		address to,
		uint256 liquidity,
		uint256 amount0MinAdjusted,
		uint256 amount1MinAdjusted,
		address router
	) internal {
		IERC20(liqInfo.pair).approve(router, liquidity);
		IUniswapV2Router(router).removeLiquidity(
			liqInfo.token0,
			liqInfo.token1,
			liquidity,
			amount0MinAdjusted,
			amount1MinAdjusted,
			to,
			block.timestamp
		);

		emit LiquidityUnstaked(
			to,
			liqInfo.pair,
			liquidity,
			amount0MinAdjusted,
			amount1MinAdjusted
		);
	}

	function _unstakeAndRemoveLiquidity(
		uint256[] memory nonces,
		address to,
		uint256[] memory amounts0Min,
		uint256[] memory amounts1Min
	) internal {
		if (nonces.length == 0) revert ZeroAmount();
		if (
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) revert InvalidInputLengths();

		StakingStorage storage $ = _stakingStorage();
		IRewards($.rewards).claimRewards(nonces, to);
		IGToken gToken_ = IGToken($.gToken);

		for (uint256 i; i < nonces.length; ++i) {
			uint256 nonce = nonces[i];
			IGToken.Attributes memory attr = gToken_.getAttributes(nonce);
			gToken_.burn(nonce);

			(
				uint256 liquidity,
				uint256 amount0MinAdjusted,
				uint256 amount1MinAdjusted,
				uint256 liqFee
			) = _computeEarlyUnlockPenalty(attr, amounts0Min[i], amounts1Min[i]);

			$.collectedPairLiqFees[attr.lpDetails.pair] += liqFee;
			if (liqFee > 0) {
				emit EarlyUnlockPenalty(msg.sender, attr.lpDetails.pair, liqFee);
				emit ProtocolLiquidityFeeCollected(attr.lpDetails.pair, liqFee);
			}

			_removeLiquidity(
				attr.lpDetails,
				to,
				liquidity,
				amount0MinAdjusted,
				amount1MinAdjusted,
				$.router
			);
		}
	}

	function _nonceBalances(
		address owner,
		uint256[] calldata nonces
	) internal view returns (uint256[] memory amounts) {
		address[] memory owners = new address[](nonces.length);
		for (uint256 i; i < nonces.length; ++i) {
			owners[i] = owner;
		}
		amounts = IERC1155(_stakingStorage().gToken).balanceOfBatch(owners, nonces);
	}

	function unStake(
		address to,
		uint256[] calldata nonces,
		uint256[] calldata amounts0Min,
		uint256[] calldata amounts1Min
	) external override {
		if (
			nonces.length == 0 ||
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) {
			revert InvalidInputLengths();
		}

		bytes memory data = abi.encode(amounts0Min, amounts1Min, to);
		uint256[] memory balances = _nonceBalances(msg.sender, nonces);

		IERC1155(_stakingStorage().gToken).safeBatchTransferFrom(
			msg.sender,
			address(this),
			nonces,
			balances,
			data
		);
	}

	modifier onlyGToken() {
		if (msg.sender != address(_stakingStorage().gToken)) {
			revert UnauthorizedGToken();
		}
		_;
	}

	function _decodeUnstakeData(
		bytes calldata data,
		uint256 expectedLength
	)
		internal
		pure
		returns (
			uint256[] memory amounts0Min,
			uint256[] memory amounts1Min,
			address to
		)
	{
		(amounts0Min, amounts1Min, to) = abi.decode(
			data,
			(uint256[], uint256[], address)
		);

		if (
			amounts0Min.length != expectedLength ||
			amounts1Min.length != expectedLength
		) {
			revert InvalidInputLengths();
		}
	}

	function onERC1155Received(
		address,
		address from,
		uint256 id,
		uint256,
		bytes calldata data
	) public virtual onlyGToken returns (bytes4) {
		uint256[] memory nonces = new uint256[](1);
		nonces[0] = id;

		(
			uint256[] memory amounts0Min,
			uint256[] memory amounts1Min,
			address to
		) = _decodeUnstakeData(data, nonces.length);

		_unstakeAndRemoveLiquidity(
			nonces,
			to == address(0) ? from : to,
			amounts0Min,
			amounts1Min
		);

		return this.onERC1155Received.selector;
	}

	function onERC1155BatchReceived(
		address,
		address from,
		uint256[] calldata ids,
		uint256[] calldata,
		bytes calldata data
	) public virtual onlyGToken returns (bytes4) {
		(
			uint256[] memory amounts0Min,
			uint256[] memory amounts1Min,
			address to
		) = _decodeUnstakeData(data, ids.length);

		_unstakeAndRemoveLiquidity(
			ids,
			to == address(0) ? from : to,
			amounts0Min,
			amounts1Min
		);

		return this.onERC1155BatchReceived.selector;
	}

	/*//////////////////////////////////////////////////////////////
	                               VIEWS
	//////////////////////////////////////////////////////////////*/

	function dEDU() public view override returns (address) {
		return IUniswapV2Router(_stakingStorage().router).dEDU();
	}

	function WEDU() public view override returns (address) {
		return IUniswapV2Router(_stakingStorage().router).WEDU();
	}

	function rewards() public view override returns (address) {
		return _stakingStorage().rewards;
	}

	function workToken() public view override returns (address) {
		return _stakingStorage().workToken;
	}

	function gToken() public view override returns (address) {
		return _stakingStorage().gToken;
	}
}
