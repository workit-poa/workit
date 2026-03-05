// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";
import {IHederaTokenService} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHederaTokenService.sol";

import {GTokenLib} from "./GTokenLib.sol";
import {SFT} from "../../abstracts/SFT.sol";
import {Epochs} from "../../libraries/Epochs.sol";
import {IGToken} from "./IGToken.sol";
import {Math} from "../../libraries/Math.sol";

/// @title GToken Contract
/// @notice WorkIt governance position token with HTS NFT integration.
/// @dev Keeps existing SFT-based accounting while adding HTS NFT lifecycle support.
contract GToken is IGToken, SFT, UUPSUpgradeable {
    using GTokenLib for IGToken.Attributes;
    using GTokenLib for bytes;
    using Epochs for Epochs.Storage;

    bytes32 public constant UPDATE_ROLE = keccak256("UPDATE_ROLE");
    bytes32 public constant BURN_ROLE = keccak256("BURN_ROLE");

    address private constant HTS_PRECOMPILE = address(0x167);
    IHederaTokenService private constant hts = IHederaTokenService(HTS_PRECOMPILE);

    /// @custom:storage-location erc7201:workit.GToken.storage
    struct GTokenStorage {
        uint256 totalStakeWeight;
        mapping(address => uint256) pairSupply;
        uint256 totalSupply;
        Epochs.Storage epochs;
        address governanceNftToken;
        uint256 governanceNftSupply;
    }

    // keccak256("workit.contracts.tokens.GToken") & ~bytes32(uint256(0xff))
    bytes32 private constant GTOKEN_STORAGE_LOCATION =
        0x20efedbc46f7d0712b2c6ed605c3ff1c601a0f7073a5fa51fd93adb6a0f55300;

    error InvalidAddress();
    error InvalidEpochLength();
    error GovernanceNftAlreadyCreated();
    error GovernanceNftNotCreated();
    error InvalidMetadata();
    error HederaCallFailed(int64 responseCode);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _getGTokenStorage()
        private
        pure
        returns (GTokenStorage storage $)
    {
        assembly {
            $.slot := GTOKEN_STORAGE_LOCATION
        }
    }

    /// @notice Initializes the WorkIt GToken contract.
    /// @param admin Admin for DEFAULT_ADMIN_ROLE and operational roles.
    /// @param epochLength Epoch duration in seconds.
    function initialize(address admin, uint256 epochLength) external initializer {
        if (admin == address(0)) revert InvalidAddress();
        if (epochLength == 0) revert InvalidEpochLength();

        __SFT_init("WorkIt Governance Token", "WGT", admin);

        _grantRole(MINTER_ROLE, admin);
        _grantRole(UPDATE_ROLE, admin);
        _grantRole(BURN_ROLE, admin);

        _getGTokenStorage().epochs.initialize(epochLength);
    }

    /// @notice Creates the WorkIt governance HTS NFT token.
    /// @param maxSupply Maximum finite NFT supply.
    /// @return tokenAddress Newly created HTS token address.
    function createGovernanceNft(
        uint256 maxSupply
    ) external payable onlyRole(DEFAULT_ADMIN_ROLE) returns (address tokenAddress) {
        if (maxSupply == 0) revert InvalidMetadata();

        GTokenStorage storage $ = _getGTokenStorage();
        if ($.governanceNftToken != address(0)) {
            revert GovernanceNftAlreadyCreated();
        }

        IHederaTokenService.KeyValue memory contractKey = IHederaTokenService
            .KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            });

        IHederaTokenService.HederaToken memory token;
        token.name = "WorkIt Governance NFT";
        token.symbol = "WGTNFT";
        token.treasury = address(this);
        token.memo = "workit-governance-nft";
        token.tokenSupplyType = true;
        token.maxSupply = _toInt64(maxSupply);
        token.freezeDefault = false;
        token.tokenKeys = new IHederaTokenService.TokenKey[](2);
        token.tokenKeys[0] = IHederaTokenService.TokenKey(0x1, contractKey); // admin
        token.tokenKeys[1] = IHederaTokenService.TokenKey(0x10, contractKey); // supply
        token.expiry = IHederaTokenService.Expiry(
            0,
            address(this),
            _toInt64(90 days)
        );

        (int64 responseCode, address createdToken) = hts
            .createNonFungibleToken{value: msg.value}(token);
        _requireSuccess(responseCode);

        $.governanceNftToken = createdToken;

        emit GovernanceNftCreated(createdToken, maxSupply, block.timestamp);
        return createdToken;
    }

    /// @notice Associates a wallet with the governance NFT token.
    function associateGovernanceNft(
        address account
    ) external onlyRole(UPDATE_ROLE) {
        if (account == address(0)) revert InvalidAddress();

        address tokenAddress = _getGTokenStorage().governanceNftToken;
        _requireGovernanceNftCreated(tokenAddress);

        int64 responseCode = hts.associateToken(account, tokenAddress);
        _requireSuccess(responseCode);

        emit GovernanceNftAssociated(account, tokenAddress, block.timestamp);
    }

    /// @notice Mints one or more governance NFTs and transfers them from treasury to recipient.
    function mintGovernanceNft(
        address to,
        bytes[] calldata metadata
    ) external onlyRole(MINTER_ROLE) returns (int64[] memory serialNumbers) {
        if (to == address(0)) revert InvalidAddress();
        if (metadata.length == 0) revert InvalidMetadata();

        GTokenStorage storage $ = _getGTokenStorage();
        address tokenAddress = $.governanceNftToken;
        _requireGovernanceNftCreated(tokenAddress);

        int64 responseCode;
        int64 newTotalSupply;
        (responseCode, newTotalSupply, serialNumbers) = hts.mintToken(
            tokenAddress,
            0,
            metadata
        );
        _requireSuccess(responseCode);

        $.governanceNftSupply = _toUint256(newTotalSupply);

        for (uint256 i = 0; i < serialNumbers.length; i++) {
            responseCode = hts.transferNFT(
                tokenAddress,
                address(this),
                to,
                serialNumbers[i]
            );
            _requireSuccess(responseCode);

            emit GovernanceNftMinted(to, serialNumbers[i], block.timestamp);
        }
    }

    /// @notice Transfers a governance NFT serial.
    function transferGovernanceNft(
        address from,
        address to,
        int64 serialNumber
    ) external onlyRole(UPDATE_ROLE) {
        if (from == address(0) || to == address(0)) revert InvalidAddress();

        address tokenAddress = _getGTokenStorage().governanceNftToken;
        _requireGovernanceNftCreated(tokenAddress);

        int64 responseCode = hts.transferNFT(tokenAddress, from, to, serialNumber);
        _requireSuccess(responseCode);

        emit GovernanceNftTransferred(from, to, serialNumber, block.timestamp);
    }

    /// @notice Burns governance NFT serials currently held by this contract treasury.
    function burnGovernanceNfts(
        int64[] calldata serialNumbers
    ) external onlyRole(BURN_ROLE) {
        if (serialNumbers.length == 0) revert InvalidMetadata();

        GTokenStorage storage $ = _getGTokenStorage();
        address tokenAddress = $.governanceNftToken;
        _requireGovernanceNftCreated(tokenAddress);

        (int64 responseCode, int64 newTotalSupply) = hts.burnToken(
            tokenAddress,
            0,
            serialNumbers
        );
        _requireSuccess(responseCode);

        $.governanceNftSupply = _toUint256(newTotalSupply);

        for (uint256 i = 0; i < serialNumbers.length; i++) {
            emit GovernanceNftBurned(serialNumbers[i], block.timestamp);
        }
    }

    function governanceNftToken() public view returns (address) {
        return _getGTokenStorage().governanceNftToken;
    }

    function governanceNftSupply() public view returns (uint256) {
        return _getGTokenStorage().governanceNftSupply;
    }

    /// @notice Mints a new GToken for the given address.
    /// @param to The address that will receive the minted GToken.
    /// @param rewardPerShare The reward per share at the time of minting.
    /// @param epochsLocked The number of epochs for which the GTokens are locked.
    /// @param lpDetails Liquidity details for stake accounting.
    /// @return uint256 The token ID of the newly minted GToken.
    function mintGToken(
        address to,
        uint256 rewardPerShare,
        uint256 epochsLocked,
        LiquidityInfo memory lpDetails
    ) external onlyRole(MINTER_ROLE) returns (uint256) {
        uint256 currentEpoch = _getGTokenStorage().epochs.currentEpoch();

        IGToken.Attributes memory attributes = IGToken
            .Attributes({
                rewardPerShare: rewardPerShare,
                epochStaked: currentEpoch,
                lastClaimEpoch: currentEpoch,
                epochsLocked: epochsLocked,
                stakeWeight: 0,
                lpDetails: lpDetails
            })
            .computeStakeWeight(currentEpoch);

        return _mintSFT(to, attributes.supply(), abi.encode(attributes));
    }

    function burn(
        address user,
        uint256 nonce,
        uint256 supply
    ) external onlyRole(BURN_ROLE) {
        _burn(user, nonce, supply);
    }

    function burn(uint256 nonce) external {
        uint256 balance = balanceOf(msg.sender, nonce);
        require(balance > 0, "No tokens at nonce");

        _burn(msg.sender, nonce, balance);
    }

    function update(
        address user,
        uint256 nonce,
        IGToken.Attributes memory attr
    ) external onlyRole(UPDATE_ROLE) returns (uint256) {
        require(balanceOf(user, nonce) > 0, "Not found");

        GTokenStorage storage $ = _getGTokenStorage();

        IGToken.Attributes memory existing = getRawTokenAttributes(nonce).decode();
        $.totalStakeWeight -= existing.stakeWeight;

        attr = attr.computeStakeWeight(_getGTokenStorage().epochs.currentEpoch());

        $.totalStakeWeight += attr.stakeWeight;
        _updateTokenAttributes(user, nonce, abi.encode(attr));

        return nonce;
    }

    function getBalanceAt(
        address user,
        uint256 nonce
    ) public view returns (Balance memory) {
        uint256 amount = balanceOf(user, nonce);
        require(amount > 0, "No GToken balance found at nonce for user");

        return _packageBalance(nonce, amount, getRawTokenAttributes(nonce));
    }

    function getAttributes(
        uint256 nonce
    ) external view returns (IGToken.Attributes memory) {
        return getRawTokenAttributes(nonce).decode();
    }

    function epochs() external view returns (Epochs.Storage memory) {
        return _getGTokenStorage().epochs;
    }

    function _packageBalance(
        uint256 nonce,
        uint256 amount,
        bytes memory attr
    ) private view returns (Balance memory) {
        IGToken.Attributes memory attrUnpacked = attr.decode();
        uint256 votePower = attrUnpacked.votePower(
            _getGTokenStorage().epochs.currentEpoch()
        );

        return
            Balance({
                nonce: nonce,
                amount: amount,
                attributes: attrUnpacked,
                votePower: votePower
            });
    }

    function getBalance(address user) public view returns (Balance[] memory) {
        SftBalance[] memory _sftBals = _sftBalance(user);
        Balance[] memory balance = new Balance[](_sftBals.length);

        for (uint256 i = 0; i < _sftBals.length; i++) {
            SftBalance memory _sftBal = _sftBals[i];

            balance[i] = _packageBalance(
                _sftBal.nonce,
                _sftBal.amount,
                _sftBal.attributes
            );
        }

        return balance;
    }

    function _intoParts(
        uint256 value,
        uint256 fullValue,
        bytes memory attributes
    ) internal pure override returns (bytes memory) {
        IGToken.Attributes memory fullAttr = attributes.decode();
        IGToken.Attributes memory attr = fullAttr;

        attr.stakeWeight = (fullAttr.stakeWeight * value) / fullValue;

        attr.lpDetails.liquidity =
            (fullAttr.lpDetails.liquidity * value) /
            fullValue;

        attr.lpDetails.liqValue =
            (fullAttr.lpDetails.liqValue * value) /
            fullValue;

        return abi.encode(attr);
    }

    function _mergeAttr(
        bytes memory firstAttr,
        uint256 firstValue,
        bytes memory secondAttr,
        uint256 secondValue
    ) internal pure override returns (bytes memory) {
        IGToken.Attributes memory A = firstAttr.decode();
        IGToken.Attributes memory B = secondAttr.decode();

        A.rewardPerShare = Math.weightedAverageRoundUp(
            A.rewardPerShare,
            firstValue,
            B.rewardPerShare,
            secondValue
        );

        if (B.epochStaked < A.epochStaked) {
            A.epochStaked = B.epochStaked;
        }

        if (B.epochsLocked > A.epochsLocked) {
            A.epochsLocked = B.epochsLocked;
        }

        uint256 newLastClaimEpoch = (A.lastClaimEpoch *
            A.stakeWeight +
            B.lastClaimEpoch *
            B.stakeWeight) / (A.stakeWeight + B.stakeWeight);

        A.lastClaimEpoch = newLastClaimEpoch;

        A.stakeWeight = A.stakeWeight + B.stakeWeight;

        A.lpDetails.liquidity = A.lpDetails.liquidity + B.lpDetails.liquidity;
        A.lpDetails.liqValue = A.lpDetails.liqValue + B.lpDetails.liqValue;

        return abi.encode(A);
    }

    function _ensureCanTransfer(
        uint256,
        address,
        address,
        bytes memory
    ) internal view override {}

    function _ensureCanMerge(
        bytes memory firstAttr,
        bytes memory secondAttr
    ) internal pure override {
        LiquidityInfo memory first = firstAttr.decode().lpDetails;
        LiquidityInfo memory second = secondAttr.decode().lpDetails;

        if (first.pair != second.pair)
            revert UnAuthorizedSFTMerge(
                firstAttr,
                secondAttr,
                "Liquidity Pool Mismatch"
            );
    }

    function _updateHook(
        uint256 id,
        address from,
        address to,
        uint256 value,
        bytes memory attributes
    ) internal override {
        IGToken.Attributes memory attr = attributes.decode();

        uint256 stakeWeight = attr.stakeWeight;
        address pair = attr.lpDetails.pair;

        GTokenStorage storage $ = _getGTokenStorage();

        if (from == address(0)) {
            $.totalStakeWeight += stakeWeight;
            $.totalSupply += value;
            $.pairSupply[pair] += value;
        } else if (to == address(0)) {
            $.totalStakeWeight -= stakeWeight;
            $.totalSupply -= value;
            $.pairSupply[pair] -= value;
        }

        emit GTokenTransfer(from, to, id, stakeWeight, value);
    }

    function pairSupply(address pair) public view returns (uint256) {
        return _getGTokenStorage().pairSupply[pair];
    }

    function totalSupply() external view returns (uint256) {
        return _getGTokenStorage().totalSupply;
    }

    function totalStakeWeight() public view returns (uint256) {
        return _getGTokenStorage().totalStakeWeight;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    function _requireSuccess(int64 responseCode) internal pure {
        if (responseCode != HederaResponseCodes.SUCCESS) {
            revert HederaCallFailed(responseCode);
        }
    }

    function _requireGovernanceNftCreated(address tokenAddress) internal pure {
        if (tokenAddress == address(0)) {
            revert GovernanceNftNotCreated();
        }
    }

    function _toInt64(uint256 amount) internal pure returns (int64) {
        return SafeCast.toInt64(SafeCast.toInt256(amount));
    }

    function _toUint256(int64 amount) internal pure returns (uint256) {
        return SafeCast.toUint256(int256(amount));
    }
}
