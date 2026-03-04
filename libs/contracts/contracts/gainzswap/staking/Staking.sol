// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";

import {IGToken} from "../tokens/GToken/IGToken.sol";
import {IGainz} from "../tokens/Gainz/IGainz.sol";
import {IRewards} from "./IRewards.sol";
import {IdEDU} from "../tokens/dEDU/IdEDU.sol";
import {IWEDU} from "../interfaces/IWEDU.sol";

import {Epochs} from "../libraries/Epochs.sol";
import {dEDULib} from "../libraries/dEDULib.sol";
import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";
import {SlidingWindowOracle} from "../uniswap-v2/SlidingWindowOracle.sol";
import {IUniswapV2Pair} from "../uniswap-v2/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Factory} from "../uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {UniswapV2LiquidityMathLibrary} from "../uniswap-v2/libraries/UniswapV2LiquidityMathLibrary.sol";
import {Math} from "../uniswap-v2/libraries/Math.sol";

import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";
import {IStaking} from "./IStaking.sol";

contract Staking is IStaking, Initializable, OwnableUpgradeable {
	using GTokenLib for IGToken.Attributes;
	using Epochs for Epochs.Storage;
	using dEDULib for address;

	/*//////////////////////////////////////////////////////////////
	                            STORAGE
	//////////////////////////////////////////////////////////////*/
	/// @custom:storage-location erc7201:ggainzswap.governance.staking.storage
	struct StakingStorage {
		address factory;
		address router;
		address rewards;
		address gainz;
		address gToken;
		Epochs.Storage epochs;
		SlidingWindowOracle oracle;
		mapping(address => uint) collectedPairLiqFees;
	}
	bytes32 internal constant STAKING_STORAGE_LOCATION =
		keccak256("gainzswap.governance.staking.storage") &
			~bytes32(uint256(0xff));

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
		address _rewards,
		SlidingWindowOracle oracle_
	) external initializer {
		__Ownable_init(msg.sender);
		if (router == address(0)) revert ZeroAmount();

		require(_rewards != address(0), "Staking: rewards = zero");

		StakingStorage storage $ = _stakingStorage();

		$.router = router;
		$.factory = IUniswapV2Router(router).factory();
		_setOracle(oracle_);

		$.rewards = _rewards;
		$.gainz = IRewards(_rewards).gainz();
		$.gToken = IRewards(_rewards).gToken();
		$.epochs = IGainz($.gainz).epochs();
	}

	/*//////////////////////////////////////////////////////////////
	                LIQUIDITY + STAKE (USER) */

	function _stakeLiquidity(
		IGToken.LiquidityInfo memory liqInfo,
		address[] memory pathToDEDU,
		address to,
		uint256 epochsLocked
	) internal {
		StakingStorage storage $ = _stakingStorage();

		liqInfo.token0 = IUniswapV2Pair(liqInfo.pair).token0();
		liqInfo.token1 = IUniswapV2Pair(liqInfo.pair).token1();

		// computePairLiquidityValue
		(uint256 amt0, uint256 amt1) = UniswapV2LiquidityMathLibrary
			.getLiquidityValue(
				$.factory,
				liqInfo.token0,
				liqInfo.token1,
				liqInfo.liquidity
			);
		uint256 amountToDEDU = _selectInputAmountForDEDU(
			liqInfo.token0,
			liqInfo.token1,
			amt0,
			amt1,
			pathToDEDU
		);
		liqInfo.liqValue = _computeLiqValue(amountToDEDU, pathToDEDU);

		IGainz($.gainz).mintGainz(); // Required to get updated IRewards.rewardPerShare value
		uint256 nonce = IGToken($.gToken).mintGToken(
			to,
			IRewards($.rewards).rewardPerShare(),
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
		StakingStorage storage $ = _stakingStorage();
		require(tokenA != tokenB, "Staking: identical tokens");

		IERC20(tokenA).approve($.router, amountADesired);
		IERC20(tokenB).approve($.router, amountBDesired);

		liqInfo.pair = IUniswapV2Factory($.factory).getPair(tokenA, tokenB);
		if (liqInfo.pair == address(0)) revert PairNotFound();

		uint256 amountA;
		uint256 amountB;
		(amountA, amountB, liqInfo.liquidity) = IUniswapV2Router($.router)
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

		if (amountADesired > amountA)
			IERC20(tokenA).transfer(msg.sender, amountADesired - amountA);
		if (amountBDesired > amountB)
			IERC20(tokenB).transfer(msg.sender, amountBDesired - amountB);
	}

	function _stakeDEDULiquidity(
		address token,
		uint256 dEDUAmount,
		uint256 tokenAmount,
		uint256 dEDUMin,
		uint256 tokenMin,
		address to,
		uint256 epochsLocked
	) internal {
		address[] memory pathToDEDU = new address[](1);
		pathToDEDU[0] = dEDU();

		IGToken.LiquidityInfo memory liqInfo = _addLiquidity(
			pathToDEDU[0], // dEDU
			token,
			dEDUAmount,
			tokenAmount,
			dEDUMin,
			tokenMin
		);

		_stakeLiquidity(liqInfo, pathToDEDU, to, epochsLocked);
	}

	function stakeEDULiquidity(
		address token,
		uint256 tokenAmount,
		uint256 tokenMin,
		uint256 dEDUMin,
		address to,
		uint256 epochsLocked
	) external payable {
		require(msg.value > 0, "Staking: zero EDU");

		uint256 dEDUAmount = _wrapEDU(msg.value);
		_pullToken(token, tokenAmount);

		_stakeDEDULiquidity(
			token,
			dEDUAmount,
			tokenAmount,
			dEDUMin,
			tokenMin,
			to,
			epochsLocked
		);
	}

	function stakeWEDULiquidity(
		address token,
		uint256 weduAmount,
		uint256 tokenAmount,
		uint256 tokenMin,
		uint256 dEDUMin,
		address to,
		uint256 epochsLocked
	) external {
		uint256 dEDUAmount = _wrapWEDU(weduAmount);
		_pullToken(token, tokenAmount);

		_stakeDEDULiquidity(
			token,
			dEDUAmount,
			tokenAmount,
			dEDUMin,
			tokenMin,
			to,
			epochsLocked
		);
	}

	function stakeTokensLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address[] memory pathToDEDU,
		address to,
		uint256 epochsLocked
	) external {
		if (to == address(0)) revert ZeroRecipient();

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

		_stakeLiquidity(liqInfo, pathToDEDU, to, epochsLocked);
	}

	function stakeLiquidityIn(
		address pair,
		uint256 liquidity,
		address[] memory pathToDEDU,
		address to,
		uint256 epochsLocked
	) external {
		if (to == address(0)) revert ZeroRecipient();

		IUniswapV2Pair(pair).transferFrom(msg.sender, address(this), liquidity);

		IGToken.LiquidityInfo memory liqInfo;
		liqInfo.pair = pair;
		liqInfo.liquidity = liquidity;

		_stakeLiquidity(liqInfo, pathToDEDU, to, epochsLocked);
	}

	/*//////////////////////////////////////////////////////////////
                    SINGLE-SIDED LIQUIDITY ADD
    //////////////////////////////////////////////////////////////*/

	/**
	 * @notice Computes optimal amount of tokenIn to swap for balanced LP
	 * @dev Formula used by Uniswap V2 zaps (ApeSwap / Beefy / Yearn)
	 */
	function _optimalSwapAmount(
		uint256 reserveIn,
		uint256 amountIn
	) internal pure returns (uint256) {
		if (amountIn == 0) revert ZeroAmount();
		if (reserveIn == 0) revert("InsufficientLiquidity()");

		// Simplified form of: s = (sqrt(r * (r * (2-f)^2 + 4*(1-f)*a)) - r*(2-f)) / (2*(1-f))
		// f = fee = 0.3%
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

		uint256 swapAmount;
		// compute swapAmount
		{
			IGToken.LiquidityInfo memory pairInfo; // Partial, expects just pair, token0 and token1

			// Load pair info
			pairInfo.pair = pair;
			pairInfo.token0 = IUniswapV2Pair(pair).token0();
			pairInfo.token1 = IUniswapV2Pair(pair).token1();
			// Validate pair contains required token
			if (pairInfo.token0 != tokenA && pairInfo.token1 != tokenA) {
				revert("Pair does not include required token");
			}

			address expectedPair = IUniswapV2Factory(_stakingStorage().factory)
				.getPair(pairInfo.token0, pairInfo.token1);
			if (expectedPair == address(0)) revert PairNotFound();
			if (pair != expectedPair) revert InvalidPair();

			// Read reserves
			(uint112 r0, uint112 r1, ) = IUniswapV2Pair(pairInfo.pair)
				.getReserves();
			uint256 rA;
			(rA, tokenB) = tokenA == pairInfo.token0
				? (uint256(r0), pairInfo.token1)
				: (uint256(r1), pairInfo.token0);

			// Calculate optimal swap
			swapAmount = _optimalSwapAmount(rA, totalInA);
			if (swapAmount >= totalInA) revert("InvalidSwapAmount()");
		}

		// Approve swap
		StakingStorage storage $ = _stakingStorage();
		IERC20(tokenA).approve($.router, swapAmount);

		address[] memory path = new address[](2);
		path[0] = tokenA;
		path[1] = tokenB;

		uint256[] memory amounts = IUniswapV2Router($.router)
			.swapExactTokensForTokens(
				swapAmount,
				minOutB,
				path,
				address(this),
				block.timestamp
			);

		tokenBAmount = amounts[1];
		tokenAAmount = totalInA - swapAmount;
	}

	function _optimalSwapDEDU(
		address pair,
		uint256 totalDEDU,
		uint256 tokenMinOut
	)
		internal
		returns (address token, uint256 dEDUAmount, uint256 tokenAmount)
	{
		if (totalDEDU == 0) revert ZeroAmount();

		// Perform optimal swap (dEDU → token)
		(dEDUAmount, tokenAmount, token) = _optimalSwap(
			dEDU(),
			totalDEDU,
			tokenMinOut,
			pair
		);
	}

	function stakeEDULiquidityIn(
		address pair,
		uint256 dEDUMin,
		uint256 tokenMin,
		address to,
		uint256 epochsLocked
	) external payable {
		require(msg.value > 0, "Staking: zero EDU");
		uint256 totalDEDU = _wrapEDU(msg.value);
		(
			address token,
			uint256 dEDUAmount,
			uint256 tokenAmount
		) = _optimalSwapDEDU(pair, totalDEDU, tokenMin);

		_stakeDEDULiquidity(
			token,
			dEDUAmount,
			tokenAmount,
			dEDUMin, // DEDU Min amount
			tokenMin, // token min amount
			to,
			epochsLocked
		);

		emit SingleSidedLiquidityAdded(
			msg.sender,
			pair,
			dEDU(),
			totalDEDU,
			dEDUAmount
		);
	}

	function stakeWEDULiquidityIn(
		address pair,
		uint256 weduAmount,
		uint256 dEDUMin,
		uint256 tokenMin,
		address to,
		uint256 epochsLocked
	) external {
		uint256 totalDEDU = _wrapWEDU(weduAmount);

		(
			address token,
			uint256 dEDUAmount,
			uint256 tokenAmount
		) = _optimalSwapDEDU(pair, totalDEDU, tokenMin);

		_stakeDEDULiquidity(
			token,
			dEDUAmount,
			tokenAmount,
			dEDUMin, // DEDU Min amount
			tokenMin, // token min amount
			to,
			epochsLocked
		);

		emit SingleSidedLiquidityAdded(
			msg.sender,
			pair,
			dEDU(),
			totalDEDU,
			dEDUAmount
		);
	}

	function stakeTokenLiquidityIn(
		address pair,
		address tokenA,
		uint256 tokenATotalAmount,
		uint256 tokenAMin,
		uint256 tokenBMin,
		address[] memory pathToDEDU,
		address to,
		uint256 epochsLocked
	) external {
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

		_stakeLiquidity(liqInfo, pathToDEDU, to, epochsLocked);
		emit SingleSidedLiquidityAdded(
			msg.sender,
			pair,
			tokenA,
			tokenATotalAmount,
			amountADesired
		);
	}

	/*//////////////////////////////////////////////////////////////
	            INTERNAL VALUATION / PATH HELPERS
	//////////////////////////////////////////////////////////////*/
	function _computeLiqValue(
		uint256 amountIn,
		address[] memory pathToDEDU
	) internal view returns (uint256 value) {
		StakingStorage storage $ = _stakingStorage();
		require(
			pathToDEDU.length >= 1 &&
				pathToDEDU[pathToDEDU.length - 1] == dEDU(),
			"Invalid Path to dedu"
		);
		if (pathToDEDU.length >= 2) {
			require(
				pathToDEDU[0] != pathToDEDU[pathToDEDU.length - 1],
				"Invalid Path to dedu"
			);
		}

		value = amountIn;
		for (uint256 i; i < pathToDEDU.length - 1; ++i) {
			value = $.oracle.consult(pathToDEDU[i], value, pathToDEDU[i + 1]);
		}
		value *= 2;

		require(value > 0, "Invalid liquidity for DEDU");
	}

	function _selectInputAmountForDEDU(
		address tokenA,
		address tokenB,
		uint256 amountA,
		uint256 amountB,
		address[] memory pathToDEDU
	) internal pure returns (uint256) {
		require(pathToDEDU.length >= 1, "InvalidPath");

		address input = pathToDEDU[0];

		if (input == tokenA) return amountA;
		if (input == tokenB) return amountB;

		revert("InvalidDEDUPath");
	}

	/*
	UNStAKinG
	*/

	/// @notice Computes liquidity and min amounts after early unlock penalty (stateful)
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

	/// @notice View-only getter: returns liquidity after penalty for a list of nonces
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
		)
	{
		if (
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) revert InvalidInputLengths();

		StakingStorage storage $ = _stakingStorage();
		IGToken gToken = IGToken($.gToken);

		liquidities = new uint256[](nonces.length);
		adjusted0Min = new uint256[](nonces.length);
		adjusted1Min = new uint256[](nonces.length);

		for (uint256 i; i < nonces.length; ++i) {
			IGToken.Attributes memory attr = gToken.getAttributes(nonces[i]);

			(
				liquidities[i],
				adjusted0Min[i],
				adjusted1Min[i],
				/* liqFee */

			) = _computeEarlyUnlockPenalty(
				attr,
				amounts0Min[i],
				amounts1Min[i]
			);
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
		IGToken gToken = IGToken($.gToken);

		// Process each nonce
		for (uint256 i; i < nonces.length; ++i) {
			uint256 nonce = nonces[i];

			IGToken.Attributes memory attr = gToken.getAttributes(nonce);
			gToken.burn(nonce);

			(
				uint256 liquidity,
				uint256 amount0MinAdjusted,
				uint256 amount1MinAdjusted,
				uint256 liqFee
			) = _computeEarlyUnlockPenalty(
					attr,
					amounts0Min[i],
					amounts1Min[i]
				);

			$.collectedPairLiqFees[attr.lpDetails.pair] += liqFee;
			if (liqFee > 0) {
				emit EarlyUnlockPenalty(
					msg.sender,
					attr.lpDetails.pair,
					liqFee
				);

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
		amounts = IERC1155(_stakingStorage().gToken).balanceOfBatch(
			owners,
			nonces
		);
	}

	function unStake(
		address to,
		uint256[] calldata nonces,
		uint256[] calldata amounts0Min,
		uint256[] calldata amounts1Min
	) external {
		if (
			nonces.length == 0 ||
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) {
			revert("Invalid input lengths");
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
		if (msg.sender != address(_stakingStorage().gToken))
			revert UnauthorizedGToken();
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
			revert("Invalid decoded lengths");
		}
	}

	function onERC1155Received(
		address /* operator */,
		address from,
		uint256 id,
		uint256 /* value */,
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
		address /* operator */,
		address from,
		uint256[] calldata ids,
		uint256[] calldata /* values */,
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
	                INTERNAL TOKEN HANDLING
	//////////////////////////////////////////////////////////////*/
	function _pullToken(address token, uint256 amount) internal {
		if (amount > 0)
			IERC20(token).transferFrom(msg.sender, address(this), amount);
	}

	function _wrapEDU(uint256 amount) internal returns (uint256) {
		return dEDU()._wrapEDU(amount);
	}

	function _wrapWEDU(uint256 amount) internal returns (uint256) {
		return WEDU()._wrapWEDU(dEDU(), amount);
	}

	function dEDU() public view returns (address) {
		return IUniswapV2Router(_stakingStorage().router).dEDU();
	}

	function WEDU() public view returns (address) {
		return IUniswapV2Router(_stakingStorage().router).WEDU();
	}

	function rewards() public view returns (address) {
		return _stakingStorage().rewards;
	}

	function setOracle(address oracle_) external onlyOwner {
		_setOracle(SlidingWindowOracle(oracle_));
	}

	function pokeOracle(address pair) external {
		_stakingStorage().oracle.update(
			IUniswapV2Pair(pair).token0(),
			IUniswapV2Pair(pair).token1()
		);
	}

	function oracle() public view returns (address) {
		return address(_stakingStorage().oracle);
	}

	function _setOracle(SlidingWindowOracle oracle_) internal {
		require(address(oracle_) != address(0), "Staking: oracle = zero");

		StakingStorage storage $ = _stakingStorage();
		require(
			oracle_.factory() == $.factory,
			"Staking: Oracle factory mismatch"
		);

		$.oracle = oracle_;
	}

	receive() external payable {
		if (msg.sender != WEDU()) {
			revert("Use stakeEDULiquidity");
		}
	}
}
