// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {IPair} from "./interfaces/IPair.sol";
import {ISwapFactory} from "./interfaces/ISwapFactory.sol";

import {Math} from "./libraries/Math.sol";
import {UQ112x112} from "./uniswap-v2/libraries/UQ112x112.sol";
import {FullMath} from "./uniswap-v2/libraries/FullMath.sol";

import {PairERC20} from "./abstracts/PairERC20.sol";

uint constant BASIS_POINTS = 100_00;

/// @title Pair (Modified UniswapV2Pair)
/// @notice Core AMM pair contract with configurable fee and TWAP support
contract Pair is IPair, PairERC20, OwnableUpgradeable {
	using UQ112x112 for uint224;

	// ──────────────────────────────────────────────
	// 🔒 Constants
	// ──────────────────────────────────────────────

	/// @notice Permanently locked minimum liquidity
	uint public constant MINIMUM_LIQUIDITY = 10 ** 3;

	/// @notice Base points denominator (100%)
	uint public constant FEE_BASIS_POINTS = BASIS_POINTS;

	/// @notice Minimum fee (0.05%)
	uint public constant MIN_FEE_THRESHOLD = 5;

	/// @notice Maximum fee (1.5%)
	uint public constant MAX_FEE_THRESHOLD = 150;

	/// @dev ERC20 `transfer(address,uint256)` selector
	bytes4 private constant SELECTOR =
		bytes4(keccak256("transfer(address,uint256)"));

	// ──────────────────────────────────────────────
	// 🧱 Storage (ERC7201)
	// ──────────────────────────────────────────────

	/// @custom:storage-location erc7201:gainz.Pair.storage
	struct PairStorage {
		address router;
		address token0;
		address token1;
		uint112 reserve0;
		uint112 reserve1;
		uint32 blockTimestampLast;
		uint price0CumulativeLast;
		uint price1CumulativeLast;
		uint kLast; // reserve0 * reserve1, post-liquidity-event
		uint unlocked; // re-entrancy guard
		uint minFee; // current minimum fee (basis points)
		uint maxFee; // current maximum fee (basis points)
	}

	// keccak256(abi.encode(uint256(keccak256("gainz.Pair.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant PAIR_STORAGE_LOCATION =
		0x052a7ca952fd79e6951e1e37bbd8a7a728c978d413c271dcc4d73117e8490200;

	/// @dev Returns the contract’s storage struct
	function _getPairStorage() private pure returns (PairStorage storage $) {
		assembly {
			$.slot := PAIR_STORAGE_LOCATION
		}
	}

	// ──────────────────────────────────────────────
	// 🚦 Modifiers
	// ──────────────────────────────────────────────

	/// @dev Re-entrancy guard
	modifier lock() {
		PairStorage storage $ = _getPairStorage();
		require($.unlocked == 1, "Pair: LOCKED");
		$.unlocked = 0;
		_;
		$.unlocked = 1;
	}

	// ──────────────────────────────────────────────
	// 🛠 Initialisation
	// ──────────────────────────────────────────────

	/// @notice Called once by the factory/router to set up pair
	/// @param _token0 The first ERC20 token
	/// @param _token1 The second ERC20 token
	function initialize(address _token0, address _token1) external initializer {
		__PairERC20_init();
		__Ownable_init(msg.sender);

		PairStorage storage $ = _getPairStorage();
		$.router = msg.sender;
		$.token0 = _token0;
		$.token1 = _token1;
		$.unlocked = 1;
		$.minFee = MIN_FEE_THRESHOLD;
		$.maxFee = MAX_FEE_THRESHOLD;
	}

	// ──────────────────────────────────────────────
	// 📈 Internal Functions
	// ──────────────────────────────────────────────

	/// @dev Updates reserves and price cumulatives, emits `Sync`
	function _update(
		uint balance0,
		uint balance1,
		uint112 reserve0,
		uint112 reserve1
	) private {
		PairStorage storage $ = _getPairStorage();
		require(
			balance0 <= type(uint112).max && balance1 <= type(uint112).max,
			"Pair: OVERFLOW"
		);

		uint32 blockTimestamp = uint32(block.timestamp % 2 ** 32);
		uint32 timeElapsed = blockTimestamp - $.blockTimestampLast; // overflow ok

		if (timeElapsed > 0 && reserve0 != 0 && reserve1 != 0) {
			$.price0CumulativeLast +=
				uint(UQ112x112.encode(reserve1).uqdiv(reserve0)) *
				timeElapsed;
			$.price1CumulativeLast +=
				uint(UQ112x112.encode(reserve0).uqdiv(reserve1)) *
				timeElapsed;
		}

		$.reserve0 = uint112(balance0);
		$.reserve1 = uint112(balance1);
		$.blockTimestampLast = blockTimestamp;
		emit Sync($.reserve0, $.reserve1);
	}

	/// @dev Safe ERC20 transfer: reverts on failure
	function _safeTransfer(address token, address to, uint value) private {
		(bool success, bytes memory data) = token.call(
			abi.encodeWithSelector(SELECTOR, to, value)
		);
		require(
			success && (data.length == 0 || abi.decode(data, (bool))),
			"Pair: TRANSFER_FAILED"
		);
	}

	// ──────────────────────────────────────────────
	// 🤝 Owner‑Only Fee Controls
	// ──────────────────────────────────────────────

	/// @dev Emitted when min/max fee are updated
	/// @notice Update the fee bounds
	/// @param newMinFee Minimum basis points (≥ MIN_FEE_THRESHOLD)
	/// @param newMaxFee Maximum basis points (≤ MAX_FEE_THRESHOLD)
	function setFee(uint newMinFee, uint newMaxFee) external onlyOwner {
		require(
			newMinFee >= MIN_FEE_THRESHOLD,
			"Pair: newMinFee < MIN_FEE_THRESHOLD"
		);
		require(
			newMaxFee <= MAX_FEE_THRESHOLD,
			"Pair: newMaxFee > MAX_FEE_THRESHOLD"
		);
		require(newMinFee <= newMaxFee, "Pair: newMinFee > newMaxFee");

		PairStorage storage $ = _getPairStorage();
		$.minFee = newMinFee;
		$.maxFee = newMaxFee;
		emit FeeUpdated(newMinFee, newMaxFee);
	}

	/// @notice Reset fee bounds to defaults
	function resetFee() external onlyOwner {
		PairStorage storage $ = _getPairStorage();
		$.minFee = MIN_FEE_THRESHOLD;
		$.maxFee = MAX_FEE_THRESHOLD;
		emit FeeUpdated(MIN_FEE_THRESHOLD, MAX_FEE_THRESHOLD);
	}

	// ──────────────────────────────────────────────
	// 💧 Liquidity Management
	// ──────────────────────────────────────────────

	/// @notice Mint liquidity tokens to `to`
	/// @dev Caller must be router; uses `lock` guard
	/// @return liquidity Amount of LP minted
	function mint(address to) external lock onlyOwner returns (uint liquidity) {
		PairStorage storage $ = _getPairStorage();
		(uint112 _reserve0, uint112 _reserve1, ) = getReserves();
		uint balance0 = IERC20($.token0).balanceOf(address(this));
		uint balance1 = IERC20($.token1).balanceOf(address(this));
		uint amount0 = balance0 - _reserve0;
		uint amount1 = balance1 - _reserve1;

		bool feeOn = _mintFee(_reserve0, _reserve1);
		uint _totalSupply = totalSupply();
		if (_totalSupply == 0) {
			liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
			_mint(address(0), MINIMUM_LIQUIDITY); // lock minimal liquidity
		} else {
			liquidity = Math.min(
				(amount0 * _totalSupply) / _reserve0,
				(amount1 * _totalSupply) / _reserve1
			);
		}
		require(liquidity > 0, "Pair: INSUFFICIENT_LIQUIDITY_MINTED");

		_mint(to, liquidity);
		_update(balance0, balance1, _reserve0, _reserve1);
		if (feeOn) {
			$.kLast = uint($.reserve0) * $.reserve1;
		}
		emit Mint(msg.sender, amount0, amount1);
	}

	/// @notice Burn LP tokens and return underlying assets to `to`
	/// @dev Caller must be router; uses `lock` guard
	/// @return amount0 Token0 withdrawn
	/// @return amount1 Token1 withdrawn
	function burn(
		address to
	) external lock onlyOwner returns (uint amount0, uint amount1) {
		PairStorage storage $ = _getPairStorage();
		(uint112 _reserve0, uint112 _reserve1) = ($.reserve0, $.reserve1);

		address _token0 = $.token0;
		address _token1 = $.token1;
		uint balance0 = IERC20(_token0).balanceOf(address(this));
		uint balance1 = IERC20(_token1).balanceOf(address(this));
		uint liquidity = balanceOf(address(this));

		bool feeOn = _mintFee(_reserve0, _reserve1);
		uint _totalSupply = totalSupply();
		amount0 = (liquidity * balance0) / _totalSupply;
		amount1 = (liquidity * balance1) / _totalSupply;
		require(
			amount0 > 0 && amount1 > 0,
			"Pair: INSUFFICIENT_LIQUIDITY_BURNED"
		);

		_burn(address(this), liquidity);
		_safeTransfer(_token0, to, amount0);
		_safeTransfer(_token1, to, amount1);

		balance0 = IERC20(_token0).balanceOf(address(this));
		balance1 = IERC20(_token1).balanceOf(address(this));
		_update(balance0, balance1, _reserve0, _reserve1);
		if (feeOn) {
			$.kLast = uint($.reserve0) * $.reserve1;
		}
		emit Burn(msg.sender, amount0, amount1, to);
	}

	// ──────────────────────────────────────────────
	// 🔄 Swaps
	// ──────────────────────────────────────────────
	struct SwapVars {
		bool feeOn;
		uint balance0;
		uint balance1;
	}

	/// @dev Returns how much of a token was sent in for a swap
	function _computeAmountIn(
		uint balance,
		uint _reserve,
		uint amountOut
	) internal pure returns (uint amountIn) {
		return
			balance > _reserve - amountOut
				? balance - (_reserve - amountOut)
				: 0;
	}

	/// @notice Swap token amounts to `to`
	/// @param amount0Out Desired amount of token0 to send out
	/// @param amount1Out Desired amount of token1 to send out
	/// @param to Recipient address
	function swap(
		uint amount0Out,
		uint amount1Out,
		address to
	) external lock onlyOwner {
		require(
			amount0Out > 0 || amount1Out > 0,
			"Pair: INSUFFICIENT_OUTPUT_AMOUNT"
		);

		PairStorage storage $ = _getPairStorage();
		(uint112 _reserve0, uint112 _reserve1, ) = getReserves();
		require(
			amount0Out < _reserve0 && amount1Out < _reserve1,
			"Pair: INSUFFICIENT_LIQUIDITY"
		);

		SwapVars memory swapVars;

		{
			address _token0 = $.token0;
			address _token1 = $.token1;
			require(to != _token0 && to != _token1, "Pair: INVALID_TO");
			if (amount0Out > 0) _safeTransfer(_token0, to, amount0Out); // optimistically transfer tokens
			if (amount1Out > 0) _safeTransfer(_token1, to, amount1Out); // optimistically transfer tokens
			// if (data.length > 0) IUniswapV2Callee(to).uniswapV2Call(msg.sender, amount0Out, amount1Out, data);
			swapVars.balance0 = IERC20(_token0).balanceOf(address(this));
			swapVars.balance1 = IERC20(_token1).balanceOf(address(this));
		}

		swapVars.feeOn = _mintFee(swapVars.balance0, swapVars.balance1);
		uint amount0In = _computeAmountIn(
			swapVars.balance0,
			_reserve0,
			amount0Out
		);
		uint amount1In = _computeAmountIn(
			swapVars.balance1,
			_reserve1,
			amount1Out
		);

		require(
			amount0In > 0 || amount1In > 0,
			"Pair: INSUFFICIENT_INPUT_AMOUNT"
		);

		{
			uint feePercent1 = calculateFeePercent(amount0In, _reserve0);
			uint feePercent0 = calculateFeePercent(amount1In, _reserve1);

			uint bal0Adj = (swapVars.balance0 * FEE_BASIS_POINTS) -
				(amount0In * feePercent0);
			uint bal1Adj = (swapVars.balance1 * FEE_BASIS_POINTS) -
				(amount1In * feePercent1);

			require(
				bal0Adj * bal1Adj >=
					uint(_reserve0) * uint(_reserve1) * (FEE_BASIS_POINTS ** 2),
				"Pair: K"
			);
		}

		_update(swapVars.balance0, swapVars.balance1, _reserve0, _reserve1);
		if (swapVars.feeOn) {
			$.kLast = uint($.reserve0) * $.reserve1;
		}

		emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
	}

	/// @dev Mint protocol fee LP tokens if fee is on
	function _mintFee(
		uint _reserve0,
		uint _reserve1
	) private returns (bool feeOn) {
		PairStorage storage $ = _getPairStorage();
		address feeTo = ISwapFactory($.router).feeTo();
		feeOn = feeTo != address(0);
		uint _kLast = $.kLast;

		if (feeOn) {
			uint rootK = Math.sqrt(uint(_reserve0) * _reserve1);
			uint rootKLast = Math.sqrt(_kLast);
			if (rootK > rootKLast) {
				uint numerator = totalSupply() * (rootK - rootKLast);
				uint denominator = rootKLast;
				uint liquidity = numerator / denominator;
				if (liquidity > 0) _mint(feeTo, liquidity);
			}
		} else if (_kLast != 0) {
			$.kLast = 0;
		}
	}

	// ──────────────────────────────────────────────
	// 🔍 Public Views & Helpers
	// ──────────────────────────────────────────────

	/// @notice Returns router address
	function router() external view returns (address) {
		return _getPairStorage().router;
	}

	/// @notice Returns token0 address
	function token0() external view returns (address) {
		return _getPairStorage().token0;
	}

	/// @notice Returns token1 address
	function token1() external view returns (address) {
		return _getPairStorage().token1;
	}

	/// @notice Returns reserves and last block timestamp
	function getReserves() public view returns (uint112, uint112, uint32) {
		PairStorage storage $ = _getPairStorage();
		return ($.reserve0, $.reserve1, $.blockTimestampLast);
	}

	/// @notice Last cumulative price of token0
	function price0CumulativeLast() external view returns (uint256) {
		return _getPairStorage().price0CumulativeLast;
	}

	/// @notice Last cumulative price of token1
	function price1CumulativeLast() external view returns (uint256) {
		return _getPairStorage().price1CumulativeLast;
	}

	/// @notice Calculate fee percent in basis points for an amount given the reserve
	function calculateFeePercent(
		uint256 amount,
		uint256 reserve
	) public view returns (uint256) {
		(uint256 r0, uint256 r1, ) = getReserves();
		require(reserve == r0 || reserve == r1, "Pair: INVALID_RESERVE");
		(uint256 minF, uint256 maxF) = feePercents();

		uint256 reserveGap = 0;
		if (reserve == r0 && r0 > r1) reserveGap = r0 - r1;
		else if (reserve == r1 && r1 > r0) reserveGap = r1 - r0;

		uint256 totalLiq = totalSupply();
		uint256 liq = ((amount + reserveGap) * totalLiq) / reserve;
		uint256 fee = minF + (liq * (maxF - minF)) / totalLiq;
		return fee > maxF ? maxF : fee;
	}

	/// @notice Returns current fee bounds (minFee, maxFee)
	function feePercents() public view returns (uint256, uint256) {
		PairStorage storage $ = _getPairStorage();
		return ($.minFee, $.maxFee);
	}
}
