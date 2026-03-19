// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {HederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/HederaTokenService.sol";
import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

contract SafeHederaTokenService is HederaTokenService {
    event Transfer(address indexed from, address indexed to, uint64 value);
    event Approve(address indexed spender, uint64 value);

    function _safeMintToken(address token, address to, uint256 amount, bytes[] memory metadata) internal
        returns (int64 newTotalSupply, int64[] memory serialNumbers)
    {
        int responseCode;
        (responseCode, newTotalSupply, serialNumbers) = HederaTokenService.mintToken(token, _toInt64(amount), metadata);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe mint failed!");
        emit Transfer(address(0), to, _toUint64(amount));
    }

    function _safeBurnToken(address token, address to, uint256 amount, int64[] memory serialNumbers) internal
        returns (int64 newTotalSupply)
    {
        int responseCode;
        (responseCode, newTotalSupply) = HederaTokenService.burnToken(token, _toInt64(amount), serialNumbers);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe burn failed!");
        emit Transfer(to, address(0), _toUint64(amount));
    }

    function _safeAssociateTokens(address account, address[] memory tokens) internal {
        int responseCode;
        responseCode = HederaTokenService.associateTokens(account, tokens);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe multiple associations failed!");
    }

    function _safeAssociateToken(address account, address token) internal {
        int responseCode;
        responseCode = HederaTokenService.associateToken(account, token);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe single association failed!");
    }

    function _safeTransferToken(address token, address sender, address receiver, uint256 amount) internal {
        int responseCode;
        responseCode = HederaTokenService.transferToken(token, sender, receiver, _toInt64(amount));
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe token transfer failed!");
        emit Transfer(sender, receiver, _toUint64(amount));
    }

    function _safeApproveToken(address token, address spender, uint256 amount) internal {
        int responseCode;
        responseCode = HederaTokenService.approve(token, spender, amount);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe approve failed!");
        emit Approve(spender, _toUint64(amount));
    }

    function _safeDissociateToken(address account, address token) internal {
        int responseCode;
        responseCode = HederaTokenService.dissociateToken(account, token);
        require(responseCode == HederaResponseCodes.SUCCESS, "Safe single association failed!");
    }

    function _toInt64(uint256 value) private pure returns (int64) {
        require(value <= ((uint256(1) << 63) - 1), "Safe cast to int64 failed");
        return int64(uint64(value));
    }

    function _toUint64(uint256 value) private pure returns (uint64) {
        require(value <= uint256(type(uint64).max), "Safe cast to uint64 failed");
        return uint64(value);
    }
}
