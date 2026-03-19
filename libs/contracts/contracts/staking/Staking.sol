// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IGToken} from "../tokens/GToken/IGToken.sol";
import {IRewards} from "./IRewards.sol";

import {Epochs} from "../libraries/Epochs.sol";
import {IUniswapV2Router01} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Router01.sol";
import {IUniswapV2Pair} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Pair.sol";
import {IUniswapV2Factory} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Factory.sol";
import {UniswapV2LiquidityMathLibrary} from "../libraries/UniswapV2LiquidityMathLibrary.sol";
import {Math} from "../libraries/Math.sol";

import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";
import {IStaking} from "./IStaking.sol";
import {SafeHederaTokenService} from "../vendor/hedera/SafeHederaTokenService.sol";

contract Staking is
    OwnableUpgradeable,
    UUPSUpgradeable,
    IStaking,
    SafeHederaTokenService
{
    using GTokenLib for IGToken.Attributes;
    using Epochs for Epochs.Storage;

    address private _factory;
    address public _router;
    address public override rewards;
    address public override workToken;
    address public override gToken;
    Epochs.Storage private _epochs;
    mapping(address => uint256) private _collectedPairLiqFees;
    mapping(address => bool) private _associationCallers;
    mapping(address => bool) private _tokenAssociated;

    error InvalidAssociationToken(address token);

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address router,
        address rewards_,
        address workToken_,
        address gToken_,
        address initialOwner
    ) external initializer {
        __Ownable_init(initialOwner);

        if (router == address(0) || rewards_ == address(0)) revert ZeroAmount();
        if (workToken_ == address(0) || gToken_ == address(0))
            revert InvalidToken();

        _router = router;
        _factory = IUniswapV2Router01(router).factory();
        rewards = rewards_;
        workToken = workToken_;
        gToken = gToken_;
        _epochs = IGToken(gToken_).epochs();
    }

    modifier onlyAssociationCaller() {
        if (msg.sender != owner() && !_associationCallers[msg.sender]) {
            revert UnauthorizedAssociator(msg.sender);
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
	                        INTERNAL HELPERS
	//////////////////////////////////////////////////////////////*/

    function _pullToken(address token, uint256 amount) internal {
        if (amount > 0) {
            _safeTransferToken(token, msg.sender, address(this), amount);
        }
    }

    function setAssociationCaller(
        address caller,
        bool allowed
    ) external onlyOwner {
        if (caller == address(0)) revert InvalidAssociationToken(caller);
        _associationCallers[caller] = allowed;
        emit AssociationCallerUpdated(caller, allowed, msg.sender);
    }

    function whbar() public view returns (address) {
        return IUniswapV2Router01(_router).WHBAR();
    }

    function whbarToken() public view returns (address) {
        return IUniswapV2Router01(_router).whbar();
    }

    function _requirePairContainsWork(
        address tokenA,
        address tokenB
    ) internal view {
        address work = workToken;
        if (tokenA != work && tokenB != work) revert InvalidToken();
    }

    function _validatedPairTokens(
        address pair
    ) internal view returns (address token0, address token1) {
        token0 = IUniswapV2Pair(pair).token0();
        token1 = IUniswapV2Pair(pair).token1();

        address expectedPair = IUniswapV2Factory(_factory).getPair(
            token0,
            token1
        );
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
            .getLiquidityValue(_factory, token0, token1, liquidity);

        address work = workToken;
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

        uint256 nonce = IGToken(gToken).mintGToken(
            to,
            IRewards(rewards).rewardPerShare(),
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

        liqInfo.pair = IUniswapV2Factory(_factory).getPair(tokenA, tokenB);
        if (liqInfo.pair == address(0)) revert PairNotFound();

        IERC20(tokenA).approve(_router, amountADesired);
        IERC20(tokenB).approve(_router, amountBDesired);

        (
            uint256 amountA,
            uint256 amountB,
            uint256 liquidity
        ) = IUniswapV2Router01(_router).addLiquidity(
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

    function _addLiquidityEth(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountHbarMin,
        uint256 amountHbarDesired
    ) internal returns (IGToken.LiquidityInfo memory liqInfo) {
        address _whbarToken = whbarToken();
        _requirePairContainsWork(token, _whbarToken);

        liqInfo.pair = IUniswapV2Factory(_factory).getPair(token, _whbarToken);
        if (liqInfo.pair == address(0)) revert PairNotFound();

        IERC20(token).approve(_router, amountTokenDesired);
        (
            uint256 amountToken,
            uint256 amountHbar,
            uint256 liquidity
        ) = IUniswapV2Router01(_router).addLiquidityETH{
                value: amountHbarDesired
            }(
                token,
                amountTokenDesired,
                amountTokenMin,
                amountHbarMin,
                address(this),
                block.timestamp
            );

        liqInfo.liquidity = liquidity;

        if (amountTokenDesired > amountToken) {
            IERC20(token).transfer(
                msg.sender,
                amountTokenDesired - amountToken
            );
        }
        if (amountHbarDesired > amountHbar) {
            (bool refunded, ) = payable(msg.sender).call{
                value: amountHbarDesired - amountHbar
            }("");
            if (!refunded) revert NativeTransferFailed();
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
        address to,
        uint256 epochsLocked
    ) external override {
        if (liquidity == 0) revert ZeroAmount();
        _validatedPairTokens(pair);

        _pullToken(IUniswapV2Pair(pair).lpToken(), liquidity);

        IGToken.LiquidityInfo memory liqInfo;
        liqInfo.pair = pair;
        liqInfo.liquidity = liquidity;

        _stakeLiquidity(liqInfo, to, epochsLocked);
    }

    function safeAssociateTokens(
        address[] calldata tokens
    )
        external
        override
        onlyAssociationCaller
        returns (
            uint256 associatedCount,
            uint256 alreadyAssociatedCount,
            uint256 nonHtsCount
        )
    {
        for (uint256 i = 0; i < tokens.length; ) {
            address token = tokens[i];
            if (_tokenAssociated[token]) {
                alreadyAssociatedCount++;
            } else {
                _safeAssociateToken(address(this), token);
                _tokenAssociated[token] = true;
                associatedCount++;
            }

            unchecked {
                i++;
            }
        }

        nonHtsCount = 0;
    }

    function stakeTokenHbarLiquidity(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountHbarMin,
        address to,
        uint256 epochsLocked
    ) external payable override {
        if (msg.value == 0) revert ZeroAmount();
        _pullToken(token, amountTokenDesired);

        IGToken.LiquidityInfo memory liqInfo = _addLiquidityEth(
            token,
            amountTokenDesired,
            amountTokenMin,
            amountHbarMin,
            msg.value
        );

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
        IERC20(tokenIn).approve(_router, amountIn);

        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;

        uint256[] memory amounts = IUniswapV2Router01(_router)
            .swapExactTokensForTokens(
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
	                     TOKEN ASSOCIATION
	//////////////////////////////////////////////////////////////*/

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
        uint256 liquidity = attr.lpDetails.liquidity;

        liquidityToReturn = attr.epochsLocked == 0
            ? liquidity
            : attr.valueToKeep(liquidity, _epochs.currentEpoch());

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

        IGToken gToken_ = IGToken(gToken);

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
        IUniswapV2Router01(router).removeLiquidity(
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

        IRewards(rewards).claimRewards(nonces, to);
        IGToken gToken_ = IGToken(gToken);

        for (uint256 i; i < nonces.length; ++i) {
            uint256 nonce = nonces[i];
            IGToken.Attributes memory attr = gToken_.getAttributes(nonce);
            gToken_.burn(nonce);

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

            _collectedPairLiqFees[attr.lpDetails.pair] += liqFee;
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
                _router
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
        amounts = IERC1155(gToken).balanceOfBatch(owners, nonces);
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

        IERC1155(gToken).safeBatchTransferFrom(
            msg.sender,
            address(this),
            nonces,
            balances,
            data
        );
    }

    modifier onlyGToken() {
        if (msg.sender != address(gToken)) {
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

    function _authorizeUpgrade(address) internal override onlyOwner {}

    /*//////////////////////////////////////////////////////////////
	                               VIEWS
	//////////////////////////////////////////////////////////////*/

    receive() external payable {}

    uint256[50] private __gap;
}
