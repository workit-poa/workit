// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {SwapFactory} from "./abstracts/SwapFactory.sol";
import {UniswapV2RouterUpgradeable} from "./abstracts/UniswapV2RouterUpgradeable.sol";
import {UserModule} from "./abstracts/UserModule.sol";

import {Epochs} from "./libraries/Epochs.sol";
import {AMMLibrary} from "./libraries/AMMLibrary.sol";

import {IPair} from "./interfaces/IPair.sol";
import {IRouterCore} from "./interfaces/IRouterCore.sol";

contract Router is
	SwapFactory,
	OwnableUpgradeable,
	UserModule,
	UniswapV2RouterUpgradeable,
	IRouterCore
{
	using Epochs for Epochs.Storage;

	/// @custom:storage-location erc7201:gainz.Router.storage
	struct RouterStorage {
		address feeTo;
		address feeToSetter;
		//
		address wNativeToken;
		address proxyAdmin;
		address pairsBeacon;
		address governance;
		Epochs.Storage epochs;
		address oracle;
	}
	// keccak256(abi.encode(uint256(keccak256("gainz.Router.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant ROUTER_STORAGE_LOCATION =
		0xae974aecfb7025a5d7fc4d7e9ba067575060084b22f04fa48d6bbae6c0d48d00;
	address private _originalCaller; // Deprecated

	function _getRouterStorage()
		private
		pure
		returns (RouterStorage storage $)
	{
		assembly {
			$.slot := ROUTER_STORAGE_LOCATION
		}
	}

	// **** INITIALIZATION ****
	function initialize(
		address _wedu,
		address _dedu,
		address _factory
	) public initializer {
		__Ownable_init(msg.sender);
		__UniswapV2Router_init(_factory, _wedu, _dedu);
	}

	/// @notice Upgrade initializer (V2)
	/// @custom:oz-upgrades-validate-as-initializer
	function initializeV2(
		address _wedu,
		address _dedu,
		address _factory
	) external reinitializer(2) {
		__Ownable_init(owner()); // call OwnableUpgradeable initializer
		__UniswapV2Router_init(_factory, _wedu, _dedu); // call parent router initializer
		// Note: Do NOT call __Ownable_init here; already called in initialize()
	}

	function removeLiquidityOld(
		address tokenA,
		address tokenB,
		uint liquidity,
		uint amountAMin,
		uint amountBMin,
		address to,
		uint deadline
	) external ensure(deadline) returns (uint amountA, uint amountB) {
		address pair = oldPairFor(tokenA, tokenB);
		require(pair != address(0), "Router: INVALID_PAIR");

		// Transfer liquidity tokens from the sender to the pair
		IPair(pair).transferFrom(msg.sender, pair, liquidity);

		// Burn liquidity tokens to receive tokenA and tokenB
		(uint amount0, uint amount1) = IPair(pair).burn(to);
		(address token0, ) = AMMLibrary.sortTokens(tokenA, tokenB);
		(amountA, amountB) = tokenA == token0
			? (amount0, amount1)
			: (amount1, amount0);

		// Ensure minimum amounts are met
		if (amountA < amountAMin) revert("InSufficientAAmount()");
		if (amountB < amountBMin) revert("InSufficientBAmount()");
	}

	// ******* VIEWS *******
	function feeTo() external view returns (address) {
		return _getRouterStorage().feeTo;
	}

	function feeToSetter() public view returns (address) {
		return _getRouterStorage().feeToSetter;
	}

	function setFeeTo(address _feeTo) external {
		require(msg.sender == feeToSetter(), "Router: FORBIDDEN");
		_getRouterStorage().feeTo = _feeTo;
	}

	function setFeeToSetter(address _feeToSetter) external {
		require(msg.sender == feeToSetter(), "Router: FORBIDDEN");
		_getRouterStorage().feeToSetter = _feeToSetter;
	}
}
