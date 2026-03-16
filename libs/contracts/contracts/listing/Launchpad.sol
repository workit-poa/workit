// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/interfaces/IERC1155Receiver.sol";

import {IHRC719} from "@hashgraph/smart-contracts/contracts/system-contracts/hedera-token-service/IHRC719.sol";
import {HederaResponseCodes} from "@hashgraph/smart-contracts/contracts/system-contracts/HederaResponseCodes.sol";

import {ICampaign} from "./ICampaign.sol";
import {ILaunchpad} from "./ILaunchpad.sol";
import {IStaking} from "../staking/IStaking.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {CampaignFactory} from "../abstracts/CampaignFactory.sol";
import {CampaignLib} from "./CampaignLib.sol";
import {UniswapV2Library} from "../libraries/UniswapV2Library.sol";

contract Launchpad is Ownable, ERC1155, ILaunchpad, CampaignFactory, IERC1155Receiver {
	using SafeERC20 for IERC20;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;
	using CampaignLib for address;

	uint256 public constant MIN_DURATION = 1 minutes;

	uint256 public constant MAX_LOCK_EPOCHS = 1080;
	uint256 public constant MIN_LOCK_EPOCHS = 90;
	bytes4 private constant WRAPPED_TOKEN_SELECTOR =
		bytes4(keccak256("token()"));

	address public override factory;
	address private _gToken;
	address private _staking;
	mapping(address => address) public override campaignPair;
	mapping(address => EnumerableSet.UintSet) private _userCampaignIds;
	mapping(uint256 => uint256) public override tokenBalance;

	constructor(
		address factory_,
		address gToken_,
		address staking_
	) Ownable(msg.sender) ERC1155("") {
		if (factory_ == address(0)) revert InvalidAddress(factory_);
		if (gToken_ == address(0)) revert InvalidAddress(gToken_);
		if (staking_ == address(0)) revert InvalidAddress(staking_);

		factory = factory_;
		_gToken = gToken_;
		_staking = staking_;
	}

	/*//////////////////////////////////////////////////////////////
	                     HTS + RECEIVER LOGIC
	//////////////////////////////////////////////////////////////*/

	function supportsInterface(
		bytes4 interfaceId
	) public view override(ERC1155, IERC165) returns (bool) {
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

	function associateTokenIfNeeded(
		address token
	) public override returns (bool associated) {
		if (token == address(0)) revert InvalidAddress(token);

		try IHRC719(token).associate() returns (uint256 responseCode) {
			uint256 successCode = uint256(int256(HederaResponseCodes.SUCCESS));
			uint256 alreadyAssociatedCode = uint256(
				int256(HederaResponseCodes.TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT)
			);
			if (responseCode == successCode) return true;
			if (responseCode == alreadyAssociatedCode) return false;
			revert TokenAssociationFailed(token, responseCode);
		} catch {
			// EVM-native tokens won't implement HRC-719 and don't need explicit association.
			return false;
		}
	}

	function _resolveErc20Token(address token) internal view returns (address) {
		(bool ok, bytes memory data) = token.staticcall(
			abi.encodeWithSelector(WRAPPED_TOKEN_SELECTOR)
		);
		if (ok && data.length >= 32) {
			address underlying = abi.decode(data, (address));
			if (underlying != address(0) && underlying != token) {
				return underlying;
			}
		}
		return token;
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

	function deployPair() external payable onlyCampaigns returns (address pair) {
		ICampaign campaign = ICampaign(msg.sender);

		address existingPair = campaignPair[address(campaign)];
		if (existingPair != address(0))
			revert PairAlreadyDeployed(address(campaign), existingPair);

		ICampaign.Listing memory listing = campaign.listing();
		address fundingToken = campaign.fundingErc20Token();

		pair = UniswapV2Library.pairFor(
			factory,
			listing.campaignToken,
			fundingToken
		);
		address createdPair = IUniswapV2Factory(factory).createPair{
			value: msg.value
		}(
			listing.campaignToken,
			fundingToken
		);
		if (createdPair == address(0) || createdPair != pair)
			revert PairDeploymentFailed(
				listing.campaignToken,
				fundingToken
			);

		campaignPair[address(campaign)] = createdPair;
		associateTokenIfNeeded(createdPair);
	}

	function stakeCampaignPair() external onlyCampaigns {
		ICampaign campaign = ICampaign(msg.sender);
		address pair = campaignPair[address(campaign)];
		if (pair == address(0)) revert PairNotDeployed(address(campaign));

		ICampaign.Listing memory listing = campaign.listing();
		uint256 liquidity = IUniswapV2Pair(pair).mint(address(this));
		IERC20(pair).forceApprove(_staking, liquidity);

		IStaking(_staking).stakeLiquidityIn(
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
		address fundingToken = _resolveErc20Token(listing.fundingToken);
		if (listing.campaignToken == address(0))
			revert ZeroCampaignToken(listing.campaignToken);
		if (campaignTokenSupply == 0)
			revert ZeroCampaignTokenSupply(campaignTokenSupply);
		_requireListingContainsWorkToken(listing);

		if (listing.deadline <= block.timestamp)
			revert InvalidDeadline(listing.deadline, block.timestamp);
		uint256 duration = listing.deadline - block.timestamp;
		if (duration <= MIN_DURATION)
			revert InvalidDuration(duration, MIN_DURATION + 1, type(uint256).max);

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
			fundingToken,
			listing.campaignToken
		);
		address campaign = campaignByTokens[fundingToken][
			listing.campaignToken
		];
		if (pair != address(0) || campaign != address(0))
			revert PoolOrCampaignExists(
				fundingToken,
				listing.campaignToken,
				pair,
				campaign
			);
	}

	function _requireListingContainsWorkToken(
		ICampaign.Listing memory listing
	) internal view {
		address wrk = IStaking(_staking).workToken();
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
	) external payable onlyOwner {
		if (msg.value != 0) revert UnexpectedHbar(msg.value);
		_validateListing(listing, campaignTokenSupply);

		(address campaign, ) = _createCampaign(msg.sender, _gToken, listing);
		address fundingToken = ICampaign(campaign).fundingErc20Token();
		if (fundingToken != listing.fundingToken) {
			campaignByTokens[fundingToken][listing.campaignToken] = campaign;
			campaignByTokens[listing.campaignToken][fundingToken] = campaign;
		}
		ICampaign(campaign).associateListingTokens();

		IERC20(listing.campaignToken).safeTransferFrom(
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
		return IStaking(_staking).workToken();
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
}
