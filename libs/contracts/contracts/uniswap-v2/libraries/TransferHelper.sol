// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// helper methods for interacting with ERC20 tokens and sending ETH that do not consistently return true/false
library TransferHelper {
	function safeApprove(address token, address to, uint256 value) internal {
		// bytes4(keccak256(bytes('approve(address,uint256)')));
		(bool success, bytes memory data) = token.call(
			abi.encodeWithSelector(0x095ea7b3, to, value)
		);
		_handleReturnData(success, data);
	}

	function safeTransfer(address token, address to, uint256 value) internal {
		// bytes4(keccak256(bytes('transfer(address,uint256)')));
		(bool success, bytes memory data) = token.call(
			abi.encodeWithSelector(0xa9059cbb, to, value)
		);
		_handleReturnData(success, data);
	}

	function safeTransferFrom(
		address token,
		address from,
		address to,
		uint256 value
	) internal {
		// bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
		(bool success, bytes memory data) = token.call(
			abi.encodeWithSelector(0x23b872dd, from, to, value)
		);
		_handleReturnData(success, data);
	}

	function safeTransferETH(address to, uint256 value) internal {
		(bool success, bytes memory returnData) = to.call{value: value}(
			new bytes(0)
		);
		_handleReturnData(success, returnData);
	}

	function _handleReturnData(
		bool success,
		bytes memory returnData
	) internal pure {
		// Inline assembly to handle errors
		assembly {
			// If the call failed, check if there is return data (error message)
			if iszero(success) {
				if gt(mload(returnData), 0) {
					// Revert with the actual error message from the failed call
					revert(add(returnData, 32), mload(returnData))
				}
				// If there is no return data, revert with a generic message
				revert(0, 0)
			}
		}
	}
}
