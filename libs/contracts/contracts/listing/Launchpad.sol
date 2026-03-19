// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/interfaces/IERC1155Receiver.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ICampaign} from "./ICampaign.sol";
import {ILaunchpad} from "./ILaunchpad.sol";
import {IStaking} from "../staking/IStaking.sol";
import {IUniswapV2Factory} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../../vendor/saucerswap-periphery/contracts/interfaces/IUniswapV2Pair.sol";
import {CampaignFactory} from "../abstracts/CampaignFactory.sol";
import {CampaignLib} from "./CampaignLib.sol";
import {UniswapV2Library} from "../libraries/UniswapV2Library.sol";
import {SafeHederaTokenService} from "../vendor/hedera/SafeHederaTokenService.sol";

contract Launchpad is
    OwnableUpgradeable,
    ERC1155Upgradeable,
    UUPSUpgradeable,
    ILaunchpad,
    CampaignFactory,
    IERC1155Receiver,
    SafeHederaTokenService
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.UintSet;
    using CampaignLib for address;

    uint256 public constant MIN_DURATION = 1 minutes;

    uint256 public constant MAX_LOCK_EPOCHS = 1080;
    uint256 public constant MIN_LOCK_EPOCHS = 90;

    address public override factory;
    address public campaignBeacon;
    address private _gToken;
    address public staking;
    mapping(address => address) public override campaignPair;
    mapping(address => EnumerableSet.UintSet) private _userCampaignIds;
    mapping(uint256 => uint256) public override tokenBalance;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address factory_,
        address gToken_,
        address staking_,
        address campaignBeacon_,
        address initialOwner
    ) external initializer {
        __ERC1155_init("");
        __Ownable_init(initialOwner);

        if (factory_ == address(0)) revert InvalidAddress(factory_);
        if (gToken_ == address(0)) revert InvalidAddress(gToken_);
        if (staking_ == address(0)) revert InvalidAddress(staking_);
        if (campaignBeacon_ == address(0))
            revert InvalidAddress(campaignBeacon_);

        factory = factory_;
        campaignBeacon = campaignBeacon_;
        _gToken = gToken_;
        staking = staking_;
    }

    /*//////////////////////////////////////////////////////////////
	                     HTS + RECEIVER LOGIC
	//////////////////////////////////////////////////////////////*/

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155Upgradeable, IERC165) returns (bool) {
        return
            interfaceId == type(IERC1155Receiver).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes calldata
    ) external view override returns (bytes4) {
        if (msg.sender != _gToken) {
            revert UnauthorizedGToken(msg.sender, _gToken);
        }
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] calldata,
        uint256[] calldata,
        bytes calldata
    ) external view override returns (bytes4) {
        if (msg.sender != _gToken) {
            revert UnauthorizedGToken(msg.sender, _gToken);
        }
        return this.onERC1155BatchReceived.selector;
    }

    modifier onlyCampaigns() {
        if (!isCampaign(msg.sender)) revert OnlyCampaigns(msg.sender);
        _;
    }

    /*//////////////////////////////////////////////////////////////
	                     SFT MINT/BURN LOGIC
	//////////////////////////////////////////////////////////////*/

    function mint(address to, uint256 amount) external onlyCampaigns {
        uint256 id = msg.sender.tokenId();
        _mint(to, id, amount, "");
        tokenBalance[id] += amount;
    }

    function burn(address from, uint256 amount) external onlyCampaigns {
        uint256 id = msg.sender.tokenId();
        uint256 balance = balanceOf(from, id);
        if (balance < amount)
            revert InsufficientClaimBalance(from, id, balance, amount);

        _burn(from, id, amount);
        unchecked {
            tokenBalance[id] -= amount;
        }
    }

    /*//////////////////////////////////////////////////////////////
	                     PAIR DEPLOYMENT
	//////////////////////////////////////////////////////////////*/

    function deployPair(
        address campaign
    ) external payable returns (address pair) {
        if (!isCampaign(campaign)) revert InvalidCampaign(campaign);

        ICampaign.Listing memory listing = ICampaign(campaign).listing();
        pair = campaignPair[campaign];

        if (pair == address(0)) {
            pair = IUniswapV2Factory(factory).getPair(
                listing.campaignToken,
                listing.fundingToken
            );

            if (pair == address(0)) {
                address expectedPair = UniswapV2Library.pairFor(
                    factory,
                    listing.campaignToken,
                    listing.fundingToken
                );
                address createdPair = IUniswapV2Factory(factory).createPair{
                    value: msg.value
                }(listing.campaignToken, listing.fundingToken);
                if (createdPair == address(0) || createdPair != expectedPair)
                    revert PairDeploymentFailed(
                        listing.campaignToken,
                        listing.fundingToken
                    );

                pair = createdPair;
            }

            campaignPair[campaign] = pair;
        }
    }

    function stakeCampaignPair() external onlyCampaigns {
        ICampaign campaign = ICampaign(msg.sender);
        address pair = campaignPair[address(campaign)];
        if (pair == address(0)) revert PairNotDeployed(address(campaign));

        ICampaign.Listing memory listing = ICampaign(campaign).listing();

        address lpToken = IUniswapV2Pair(pair).lpToken();
        _safeAssociateToken(address(this), lpToken);

        address[] memory stakingTokens = new address[](3);
        stakingTokens[0] = lpToken;
        stakingTokens[1] = listing.campaignToken;
        stakingTokens[2] = listing.fundingToken;
        IStaking(staking).safeAssociateTokens(stakingTokens);

        uint256 liquidity = IUniswapV2Pair(pair).mint(address(this));
        IERC20(lpToken).approve(staking, liquidity);

        IStaking(staking).stakeLiquidityIn(
            pair,
            liquidity,
            address(campaign),
            listing.lockEpochs
        );
    }

    function _validateListing(
        ICampaign.Listing memory listing,
        uint256 campaignTokenSupply
    ) internal view {
        if (listing.campaignToken == address(0))
            revert ZeroCampaignToken(listing.campaignToken);
        if (campaignTokenSupply == 0)
            revert ZeroCampaignTokenSupply(campaignTokenSupply);
        _requireListingContainsWorkToken(listing);

        if (listing.deadline <= block.timestamp)
            revert InvalidDeadline(listing.deadline, block.timestamp);
        uint256 duration = listing.deadline - block.timestamp;
        if (duration <= MIN_DURATION)
            revert InvalidDuration(
                duration,
                MIN_DURATION + 1,
                type(uint256).max
            );

        if (
            listing.lockEpochs < MIN_LOCK_EPOCHS ||
            listing.lockEpochs > MAX_LOCK_EPOCHS
        )
            revert InvalidLockEpochs(
                listing.lockEpochs,
                MIN_LOCK_EPOCHS,
                MAX_LOCK_EPOCHS
            );

        address pair = IUniswapV2Factory(factory).getPair(
            listing.fundingToken,
            listing.campaignToken
        );
        address campaign = campaignByTokens[listing.fundingToken][
            listing.campaignToken
        ];
        if (pair != address(0) || campaign != address(0))
            revert PoolOrCampaignExists(
                listing.fundingToken,
                listing.campaignToken,
                pair,
                campaign
            );
    }

    function _requireListingContainsWorkToken(
        ICampaign.Listing memory listing
    ) internal view {
        address wrk = IStaking(staking).workToken();
        if (listing.fundingToken != wrk && listing.campaignToken != wrk)
            revert ListingMustIncludeWorkToken(
                listing.fundingToken,
                listing.campaignToken,
                wrk
            );
    }

    function createCampaign(
        ICampaign.Listing memory listing,
        uint256 campaignTokenSupply
    ) external onlyOwner {
        _validateListing(listing, campaignTokenSupply);

        (address campaign, ) = _createCampaign(
            msg.sender,
            campaignBeacon,
            _gToken,
            listing
        );

        campaignByTokens[listing.fundingToken][
            listing.campaignToken
        ] = campaign;
        campaignByTokens[listing.campaignToken][
            listing.fundingToken
        ] = campaign;

        _safeTransferToken(
            listing.campaignToken,
            msg.sender,
            campaign,
            campaignTokenSupply
        );
        ICampaign(campaign).resolveCampaign(address(0));

        Address.functionCall(
            campaign,
            abi.encodeWithSignature("transferOwnership(address)", msg.sender)
        );
    }

    /*//////////////////////////////////////////////////////////////
	                          VIEWS
	//////////////////////////////////////////////////////////////*/

    function workToken() public view returns (address) {
        return IStaking(staking).workToken();
    }

    function userCampaignIds(
        address user
    ) external view returns (uint256[] memory) {
        return _userCampaignIds[user].values();
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override {
        super._update(from, to, ids, values);

        uint256 idsLength = ids.length;
        for (uint256 i; i < idsLength; ) {
            uint256 id = ids[i];

            if (from != address(0) && balanceOf(from, id) == 0) {
                _userCampaignIds[from].remove(id);
            }
            if (to != address(0) && balanceOf(to, id) > 0) {
                _userCampaignIds[to].add(id);
            }

            unchecked {
                ++i;
            }
        }
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    uint256[50] private __gap;
}
