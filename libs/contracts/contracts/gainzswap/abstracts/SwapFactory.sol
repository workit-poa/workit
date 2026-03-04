// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.28;

import {ISwapFactory} from "../interfaces/ISwapFactory.sol";

abstract contract SwapFactory is ISwapFactory {
	/// @custom:storage-location erc7201:gainz.SwapFactory.storage
	struct SwapFactoryStorage {
		mapping(address => mapping(address => address)) pairMap;
		address[] pairs;
	}
	// keccak256(abi.encode(uint256(keccak256("gainz.SwapFactory.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant SWAP_FACTORY_STORAGE_LOCATION =
		0xc4825425231a5778c376b527fa35b881155eeee14e05c41074ff3d19f04f4c00;

	function _getSwapFactoryStorage()
		private
		pure
		returns (SwapFactoryStorage storage $)
	{
		assembly {
			$.slot := SWAP_FACTORY_STORAGE_LOCATION
		}
	}

	function oldPairs() external view returns (address[] memory) {
		return _getSwapFactoryStorage().pairs;
	}

	function oldPairFor(
		address tokenA,
		address tokenB
	) public view returns (address) {
		return _getSwapFactoryStorage().pairMap[tokenA][tokenB];
	}

	// function _createPair(
	// 	address tokenA,
	// 	address tokenB,
	// 	address pairsBeacon
	// ) internal returns (address pair) {
	// 	if (tokenA == tokenB) revert IdenticalAddress();
	// 	(address token0, address token1) = tokenA < tokenB
	// 		? (tokenA, tokenB)
	// 		: (tokenB, tokenA);
	// 	if (token0 == address(0)) revert ZeroAddress(); // This check is sufficient

	// 	SwapFactoryStorage storage $ = _getSwapFactoryStorage();

	// 	if ($.pairMap[token0][token1] != address(0)) revert PairExists(); // single check is sufficient

	// 	pair = address(
	// 		new BeaconProxy{
	// 			salt: keccak256(abi.encodePacked(token0, token1))
	// 		}(
	// 			pairsBeacon,
	// 			abi.encodeWithSelector(Pair.initialize.selector, token0, token1)
	// 		)
	// 	);

	// 	$.pairMap[token0][token1] = pair;
	// 	$.pairMap[token1][token0] = pair; // populate mapping in the reverse direction
	// 	$.pairs.push(pair);
	// 	emit PairCreated(token0, token1, pair, $.pairs.length);
	// }
}
