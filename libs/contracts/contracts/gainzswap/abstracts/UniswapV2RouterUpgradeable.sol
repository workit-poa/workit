// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IWEDU} from "../interfaces/IWEDU.sol";
import {IUniswapV2Router} from "../interfaces/IUniswapV2Router.sol";

import {UniswapV2Library} from "../uniswap-v2/libraries/UniswapV2Library.sol";
import {TransferHelper} from "../uniswap-v2/libraries/TransferHelper.sol";
import {IUniswapV2Factory} from "../uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../uniswap-v2/interfaces/IUniswapV2Pair.sol";

import {IdEDU} from "../tokens/dEDU/IdEDU.sol";

/// @title UniswapV2RouterUpgradeable
/// @notice Upgradeable, abstract version of Uniswap V2 Router using EIP-7201 storage
abstract contract UniswapV2RouterUpgradeable is
	Initializable,
	IUniswapV2Router
{
	/*//////////////////////////////////////////////////////////////
	                            STORAGE
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:uniswap.v2.router.storage
	struct UniswapV2RouterStorage {
		address factory;
		address WEDU;
		address dEDU;
	}

	bytes32 internal constant ROUTER_STORAGE_SLOT =
		keccak256("uniswap.v2.router.storage");

	function _routerStorage()
		private
		pure
		returns (UniswapV2RouterStorage storage $)
	{
		bytes32 slot = ROUTER_STORAGE_SLOT;
		assembly {
			$.slot := slot
		}
	}

	/*//////////////////////////////////////////////////////////////
	                           INITIALIZER
	//////////////////////////////////////////////////////////////*/

	function __UniswapV2Router_init(
		address factory_,
		address wedu_,
		address dedu_
	) internal onlyInitializing {
		UniswapV2RouterStorage storage $ = _routerStorage();

		// Validate input addresses
		require(
			factory_ != address(0),
			"UniswapV2Router: factory is zero address"
		);
		require(wedu_ != address(0), "UniswapV2Router: WEDU is zero address");
		require(dedu_ != address(0), "UniswapV2Router: dEDU is zero address");

		// Assign values
		$.factory = factory_;
		$.WEDU = wedu_;
		$.dEDU = dedu_;
	}

	/*//////////////////////////////////////////////////////////////
	                          VIEW HELPERS
	//////////////////////////////////////////////////////////////*/

	function factory() public view returns (address) {
		return _routerStorage().factory;
	}

	function WEDU() public view returns (address) {
		return _routerStorage().WEDU;
	}

	function dEDU() public view returns (address) {
		return _routerStorage().dEDU;
	}

	/*//////////////////////////////////////////////////////////////
	                           MODIFIERS
	//////////////////////////////////////////////////////////////*/

	modifier ensure(uint256 deadline) {
		require(deadline >= block.timestamp, "UniswapV2Router: EXPIRED");
		_;
	}

	receive() external payable {
		require(msg.sender == _routerStorage().WEDU, "Router: ETH not allowed");
	}

	/*//////////////////////////////////////////////////////////////
	                       LIQUIDITY LOGIC
	//////////////////////////////////////////////////////////////*/
	function _quoteLiquidity(
		uint256 reserveA,
		uint256 reserveB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin
	) internal pure returns (uint256 amountA, uint256 amountB) {
		if (reserveA == 0 && reserveB == 0) {
			return (amountADesired, amountBDesired);
		}

		uint256 amountBOptimal = UniswapV2Library.quote(
			amountADesired,
			reserveA,
			reserveB
		);

		if (amountBOptimal <= amountBDesired) {
			require(
				amountBOptimal >= amountBMin,
				"UniswapV2Router: INSUFFICIENT_B_AMOUNT"
			);
			return (amountADesired, amountBOptimal);
		}

		uint256 amountAOptimal = UniswapV2Library.quote(
			amountBDesired,
			reserveB,
			reserveA
		);
		require(
			amountAOptimal >= amountAMin,
			"UniswapV2Router: INSUFFICIENT_A_AMOUNT"
		);

		return (amountAOptimal, amountBDesired);
	}

	function _pairAndReserves(
		address tokenA,
		address tokenB
	) internal view returns (address pair, uint256 reserveA, uint256 reserveB) {
		address factory_ = factory();

		pair = IUniswapV2Factory(factory_).getPair(tokenA, tokenB);
		if (pair == address(0)) revert("PAIR_NOT_EXISTS");

		(reserveA, reserveB) = UniswapV2Library.getReserves(
			factory_,
			tokenA,
			tokenB
		);
	}

	function _addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin
	) internal view returns (address pair, uint256 amountA, uint256 amountB) {
		uint256 reserveA;
		uint256 reserveB;

		(pair, reserveA, reserveB) = _pairAndReserves(tokenA, tokenB);

		(amountA, amountB) = _quoteLiquidity(
			reserveA,
			reserveB,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin
		);
	}

	function addLiquidity(
		address tokenA,
		address tokenB,
		uint256 amountADesired,
		uint256 amountBDesired,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	)
		external
		ensure(deadline)
		returns (uint256 amountA, uint256 amountB, uint256 liquidity)
	{
		address pair;

		(pair, amountA, amountB) = _addLiquidity(
			tokenA,
			tokenB,
			amountADesired,
			amountBDesired,
			amountAMin,
			amountBMin
		);

		TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
		TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);

		liquidity = IUniswapV2Pair(pair).mint(to);
	}

	function addLiquidityETH(
		address token,
		uint256 amountTokenDesired,
		uint256 amountTokenMin,
		uint256 amountETHMin,
		address to,
		uint256 deadline
	)
		external
		payable
		ensure(deadline)
		returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
	{
		address dedu = dEDU();
		address pair;

		(pair, amountToken, amountETH) = _addLiquidity(
			token,
			dedu,
			amountTokenDesired,
			msg.value,
			amountTokenMin,
			amountETHMin
		);

		TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
		IdEDU(dedu).receiveFor{value: amountETH}(pair);

		liquidity = IUniswapV2Pair(pair).mint(to);

		if (msg.value > amountETH) {
			TransferHelper.safeTransferETH(msg.sender, msg.value - amountETH);
		}
	}

	function addLiquidityWEDU(
		address token,
		uint256 amountTokenDesired,
		uint256 amountDEDUDesired,
		uint256 amountTokenMin,
		uint256 amountDEDUMin,
		address to,
		uint256 deadline
	)
		external
		ensure(deadline)
		returns (uint256 amountToken, uint256 amountDEDU, uint256 liquidity)
	{
		address dedu = dEDU();
		address wedu = WEDU();
		address pair;

		(pair, amountToken, amountDEDU) = _addLiquidity(
			token,
			dedu,
			amountTokenDesired,
			amountDEDUDesired,
			amountTokenMin,
			amountDEDUMin
		);

		TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);

		TransferHelper.safeTransferFrom(
			wedu,
			msg.sender,
			address(this),
			amountDEDU
		);
		IWEDU(wedu).withdraw(amountDEDU);
		IdEDU(dedu).receiveFor{value: amountDEDU}(pair);

		liquidity = IUniswapV2Pair(pair).mint(to);
	}

	// **** REMOVE LIQUIDITY ****
	function removeLiquidity(
		address tokenA,
		address tokenB,
		uint256 liquidity,
		uint256 amountAMin,
		uint256 amountBMin,
		address to,
		uint256 deadline
	) public ensure(deadline) returns (uint256 amountA, uint256 amountB) {
		address pair = UniswapV2Library.pairFor(factory(), tokenA, tokenB);
		IUniswapV2Pair(pair).transferFrom(msg.sender, pair, liquidity); // send liquidity to pair
		(uint256 amount0, uint256 amount1) = IUniswapV2Pair(pair).burn(to);
		(address token0, ) = UniswapV2Library.sortTokens(tokenA, tokenB);
		(amountA, amountB) = tokenA == token0
			? (amount0, amount1)
			: (amount1, amount0);
		require(
			amountA >= amountAMin,
			"UniswapV2Router: INSUFFICIENT_A_AMOUNT"
		);
		require(
			amountB >= amountBMin,
			"UniswapV2Router: INSUFFICIENT_B_AMOUNT"
		);
	}

	// TODO: We should update dEDU to issue NFT receipts for pending withdrawal positions
	// this could open up new defi avenues where debts can be traded, and redeemed for dEDU
	// then this function here can be implemented issuing out debt receipts in NFTS
	// function removeLiquidityETH(
	// 	address token,
	// 	uint256 liquidity,
	// 	uint256 amountTokenMin,
	// 	uint256 amountETHMin,
	// 	address to,
	// 	uint256 deadline
	// )
	// 	public
	//
	//
	// 	ensure(deadline)
	// 	returns (uint256 amountToken, uint256 amountETH)
	// {
	// 	(amountToken, amountETH) = removeLiquidity(
	// 		token,
	// 		WETH,
	// 		liquidity,
	// 		amountTokenMin,
	// 		amountETHMin,
	// 		address(this),
	// 		deadline
	// 	);
	// 	TransferHelper.safeTransfer(token, to, amountToken);
	// 	IWETH(WETH).withdraw(amountETH);
	// 	TransferHelper.safeTransferETH(to, amountETH);
	// }

	// TODO: see todo on removeLiquidityETH
	// function removeLiquidityETHWithPermit(
	// 	address token,
	// 	uint256 liquidity,
	// 	uint256 amountTokenMin,
	// 	uint256 amountETHMin,
	// 	address to,
	// 	uint256 deadline,
	// 	bool approveMax,
	// 	uint8 v,
	// 	bytes32 r,
	// 	bytes32 s
	// ) external   returns (uint256 amountToken, uint256 amountETH) {
	// 	address pair = UniswapV2Library.pairFor(factory, token, WETH);
	// 	uint256 value = approveMax ? uint(-1) : liquidity;
	// 	IUniswapV2Pair(pair).permit(
	// 		msg.sender,
	// 		address(this),
	// 		value,
	// 		deadline,
	// 		v,
	// 		r,
	// 		s
	// 	);
	// 	(amountToken, amountETH) = removeLiquidityETH(
	// 		token,
	// 		liquidity,
	// 		amountTokenMin,
	// 		amountETHMin,
	// 		to,
	// 		deadline
	// 	);
	// }

	// TODO: see todo on removeLiquidityETH
	// **** REMOVE LIQUIDITY (supporting fee-on-transfer tokens) ****
	// function removeLiquidityETHSupportingFeeOnTransferTokens(
	// 	address token,
	// 	uint256 liquidity,
	// 	uint256 amountTokenMin,
	// 	uint256 amountETHMin,
	// 	address to,
	// 	uint256 deadline
	// ) public   ensure(deadline) returns (uint256 amountETH) {
	// 	(, amountETH) = removeLiquidity(
	// 		token,
	// 		WETH,
	// 		liquidity,
	// 		amountTokenMin,
	// 		amountETHMin,
	// 		address(this),
	// 		deadline
	// 	);
	// 	TransferHelper.safeTransfer(
	// 		token,
	// 		to,
	// 		IERC20(token).balanceOf(address(this))
	// 	);
	// 	IWETH(WETH).withdraw(amountETH);
	// 	TransferHelper.safeTransferETH(to, amountETH);
	// }
	// function removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(
	// 	address token,
	// 	uint256 liquidity,
	// 	uint256 amountTokenMin,
	// 	uint256 amountETHMin,
	// 	address to,
	// 	uint256 deadline,
	// 	bool approveMax,
	// 	uint8 v,
	// 	bytes32 r,
	// 	bytes32 s
	// ) external   returns (uint256 amountETH) {
	// 	address pair = UniswapV2Library.pairFor(factory, token, WETH);
	// 	uint256 value = approveMax ? uint(-1) : liquidity;
	// 	IUniswapV2Pair(pair).permit(
	// 		msg.sender,
	// 		address(this),
	// 		value,
	// 		deadline,
	// 		v,
	// 		r,
	// 		s
	// 	);
	// 	amountETH = removeLiquidityETHSupportingFeeOnTransferTokens(
	// 		token,
	// 		liquidity,
	// 		amountTokenMin,
	// 		amountETHMin,
	// 		to,
	// 		deadline
	// 	);
	// }

	// **** SWAP ****
	// requires the initial amount to have already been sent to the first pair
	function _swap(
		uint256[] memory amounts,
		address[] memory path,
		address _to
	) internal {
		address _factory = factory();
		for (uint256 i; i < path.length - 1; i++) {
			(address input, address output) = (path[i], path[i + 1]);
			(address token0, ) = UniswapV2Library.sortTokens(input, output);
			uint256 amountOut = amounts[i + 1];
			(uint256 amount0Out, uint256 amount1Out) = input == token0
				? (uint256(0), amountOut)
				: (amountOut, uint256(0));
			address to = i < path.length - 2
				? UniswapV2Library.pairFor(_factory, output, path[i + 2])
				: _to;
			IUniswapV2Pair(UniswapV2Library.pairFor(_factory, input, output))
				.swap(amount0Out, amount1Out, to, new bytes(0));
		}
	}

	function swapExactTokensForTokens(
		uint256 amountIn,
		uint256 amountOutMin,
		address[] calldata path,
		address to,
		uint256 deadline
	) external ensure(deadline) returns (uint256[] memory amounts) {
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsOut(_factory, amountIn, path);
		require(
			amounts[amounts.length - 1] >= amountOutMin,
			"UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
		);
		TransferHelper.safeTransferFrom(
			path[0],
			msg.sender,
			UniswapV2Library.pairFor(_factory, path[0], path[1]),
			amounts[0]
		);
		_swap(amounts, path, to);
	}

	function swapTokensForExactTokens(
		uint256 amountOut,
		uint256 amountInMax,
		address[] calldata path,
		address to,
		uint256 deadline
	) external ensure(deadline) returns (uint256[] memory amounts) {
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsIn(_factory, amountOut, path);
		require(
			amounts[0] <= amountInMax,
			"UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"
		);
		TransferHelper.safeTransferFrom(
			path[0],
			msg.sender,
			UniswapV2Library.pairFor(_factory, path[0], path[1]),
			amounts[0]
		);
		_swap(amounts, path, to);
	}

	function swapExactETHForTokens(
		uint256 amountOutMin,
		address[] calldata path,
		address to,
		uint256 deadline
	) external payable ensure(deadline) returns (uint256[] memory amounts) {
		address dedu = dEDU();
		require(path[0] == dedu, "UniswapV2Router: INVALID_PATH");
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsOut(_factory, msg.value, path);
		require(
			amounts[amounts.length - 1] >= amountOutMin,
			"UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
		);
		IdEDU(dedu).receiveFor{value: amounts[0]}(
			UniswapV2Library.pairFor(_factory, path[0], path[1])
		);
		_swap(amounts, path, to);
	}

	function swapExactWEDUForTokens(
		uint256 amountIn,
		uint256 amountOutMin,
		address[] calldata path,
		address to,
		uint256 deadline
	) external ensure(deadline) returns (uint256[] memory amounts) {
		address dedu = dEDU();
		address wedu = WEDU();
		require(path[0] == dedu, "UniswapV2Router: INVALID_PATH");
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsOut(_factory, amountIn, path);
		require(
			amounts[amounts.length - 1] >= amountOutMin,
			"UniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT"
		);
		TransferHelper.safeTransferFrom(
			wedu,
			msg.sender,
			address(this),
			amountIn
		);
		IWEDU(wedu).withdraw(amountIn);
		IdEDU(dedu).receiveFor{value: amountIn}(
			UniswapV2Library.pairFor(_factory, path[0], path[1])
		);
		_swap(amounts, path, to);
	}

	function swapETHForExactTokens(
		uint256 amountOut,
		address[] calldata path,
		address to,
		uint256 deadline
	) external payable ensure(deadline) returns (uint256[] memory amounts) {
		address dedu = dEDU();
		require(path[0] == dedu, "UniswapV2Router: INVALID_PATH");
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsIn(_factory, amountOut, path);
		require(
			amounts[0] <= msg.value,
			"UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"
		);
		IdEDU(dedu).receiveFor{value: amounts[0]}(
			UniswapV2Library.pairFor(_factory, path[0], path[1])
		);
		_swap(amounts, path, to);
		// refund dust eth, if any
		if (msg.value > amounts[0])
			TransferHelper.safeTransferETH(msg.sender, msg.value - amounts[0]);
	}

	function swapWEDUForExactTokens(
		uint256 amountOut,
		uint256 amountInMax,
		address[] calldata path,
		address to,
		uint256 deadline
	) external ensure(deadline) returns (uint256[] memory amounts) {
		address dedu = dEDU();
		address wedu = WEDU();
		require(path[0] == dedu, "UniswapV2Router: INVALID_PATH");
		address _factory = factory();
		amounts = UniswapV2Library.getAmountsIn(_factory, amountOut, path);
		require(
			amounts[0] <= amountInMax,
			"UniswapV2Router: EXCESSIVE_INPUT_AMOUNT"
		);
		TransferHelper.safeTransferFrom(
			wedu,
			msg.sender,
			address(this),
			amounts[0]
		);
		IWEDU(wedu).withdraw(amounts[0]);
		IdEDU(dedu).receiveFor{value: amounts[0]}(
			UniswapV2Library.pairFor(_factory, path[0], path[1])
		);
		_swap(amounts, path, to);
	}

	// **** LIBRARY VIEWS ****
	function quote(
		uint256 amountA,
		uint256 reserveA,
		uint256 reserveB
	) public pure returns (uint256 amountB) {
		return UniswapV2Library.quote(amountA, reserveA, reserveB);
	}

	function getAmountOut(
		uint256 amountIn,
		uint256 reserveIn,
		uint256 reserveOut
	) public pure returns (uint256 amountOut) {
		return UniswapV2Library.getAmountOut(amountIn, reserveIn, reserveOut);
	}

	function getAmountIn(
		uint256 amountOut,
		uint256 reserveIn,
		uint256 reserveOut
	) public pure returns (uint256 amountIn) {
		return UniswapV2Library.getAmountIn(amountOut, reserveIn, reserveOut);
	}

	function getAmountsOut(
		uint256 amountIn,
		address[] memory path
	) public view returns (uint256[] memory amounts) {
		return UniswapV2Library.getAmountsOut(factory(), amountIn, path);
	}

	function getAmountsIn(
		uint256 amountOut,
		address[] memory path
	) public view returns (uint256[] memory amounts) {
		return UniswapV2Library.getAmountsIn(factory(), amountOut, path);
	}
}
