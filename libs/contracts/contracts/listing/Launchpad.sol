// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

import {ICampaign} from "./ICampaign.sol";
import {ILaunchpad} from "./ILaunchpad.sol";
import {IGToken} from "../tokens/GToken/IGToken.sol";
import {IStaking} from "../staking/IStaking.sol";
import {IUniswapV2Factory} from "../interfaces/IUniswapV2Factory.sol";
import {IUniswapV2Pair} from "../interfaces/IUniswapV2Pair.sol";
import {CampaignFactory} from "../abstracts/CampaignFactory.sol";
import {CampaignLib} from "./CampaignLib.sol";
import {UniswapV2Library} from "../libraries/UniswapV2Library.sol";
import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";
import {Epochs} from "../libraries/Epochs.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";
import {ISFT} from "../abstracts/ISFT.sol";

contract Launchpad is
	Initializable,
	OwnableUpgradeable,
	ERC1155Upgradeable,
	ERC1155Holder,
	ILaunchpad,
	CampaignFactory
{
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;
	using CampaignLib for address;
	using GTokenLib for IGToken.Attributes;
	using Epochs for Epochs.Storage;

	uint256 public constant MAX_DURATION = 180 days;
	uint256 public constant MIN_DURATION = 30 days;

	uint256 public constant MAX_LOCK_EPOCHS = 1080;
	uint256 public constant MIN_LOCK_EPOCHS = 90;

	uint256 public constant SECURITY_GTOKEN_AMOUNT = 500 ether;
	uint256 public constant TARGET_GOAL_DEDU_VALUE = 2 * SECURITY_GTOKEN_AMOUNT;
	uint256 public constant SECURITY_GTOKEN_MIN_EPOCHS_TO_EXPIRE = 90; // 90 epochs
	string private constant LAUNCHPAD_NAME = "GainzSwap Launchpad";
	string private constant LAUNCHPAD_SYMBOL = "GLP";
	uint8 private constant LAUNCHPAD_DECIMALS = 18;

	/*//////////////////////////////////////////////////////////////
	                      ERC-7201 STORAGE
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:workit.contracts.listing.Launchpad
	struct LaunchpadStorage {
		address factory;
		address gToken;
		address staking;
		mapping(address => address[]) fundingTokenToDEDU;
		EnumerableSet.AddressSet allowedFundingTokens;
		mapping(address => address) campaignPair;
		mapping(address => uint256[]) securityNonces; // campaign => gToken nonces
		mapping(address => EnumerableSet.UintSet) userCampaignIds;
		mapping(uint256 => uint256) tokenSupply;
		//

		address campaignMigrator; // KEPT LAST SO THAT WE MIGHT REMOVE IT LATER
	}

	// keccak256("workit.contracts.listing.Launchpad") & ~bytes32(uint256(0xff))
	bytes32 private constant LAUNCHPAD_STORAGE_LOCATION =
		0x41abdac30f476ae9ebbeda7692ad43887ed9acda7f3705e022dd2c57242b8400;

	function _launchpadStorage()
		internal
		pure
		returns (LaunchpadStorage storage $)
	{
		assembly {
			$.slot := LAUNCHPAD_STORAGE_LOCATION
		}
	}

	/*//////////////////////////////////////////////////////////////
	                         INITIALIZER
	//////////////////////////////////////////////////////////////*/

	function initialize(
		address factory_,
		address gToken_,
		address campaignBeacon,
		string memory uri_,
		address staking_
	) external initializer {
		if (factory_ == address(0)) revert InvalidAddress(factory_);
		if (gToken_ == address(0)) revert InvalidAddress(gToken_);
		if (staking_ == address(0)) revert InvalidAddress(staking_);

		__Ownable_init(msg.sender);
		__ERC1155_init(uri_);
		__CampaignFactory_init(campaignBeacon);

		LaunchpadStorage storage $ = _launchpadStorage();
		$.factory = factory_;
		$.gToken = gToken_;
		$.staking = staking_;
	}

	function name() external pure returns (string memory) {
		return LAUNCHPAD_NAME;
	}

	function symbol() external pure returns (string memory) {
		return LAUNCHPAD_SYMBOL;
	}

	function decimals() external pure returns (uint8) {
		return LAUNCHPAD_DECIMALS;
	}

	/*//////////////////////////////////////////////////////////////
	                     ERC1155 LOGIC
	//////////////////////////////////////////////////////////////*/

	function supportsInterface(
		bytes4 interfaceId
	)
		public
		view
		virtual
		override(ERC1155Upgradeable, ERC1155Holder)
		returns (bool)
	{
		return super.supportsInterface(interfaceId);
	}

	modifier onlyCampaigns() {
		if (!isCampaign(msg.sender)) revert OnlyCampaigns(msg.sender);
		_;
	}

	modifier onlyCampaignMigrator() {
		address migrator = _launchpadStorage().campaignMigrator;
		if (msg.sender != migrator)
			revert NotCampaignMigrator(msg.sender, migrator);
		_;
	}

	function mint(address to, uint256 amount) external onlyCampaigns {
		uint256 id = msg.sender.tokenId();
		_mint(to, id, amount, "");
	}

	function burn(address from, uint256 amount) external onlyCampaigns {
		uint256 id = msg.sender.tokenId();

		uint256 balance = balanceOf(from, id);
		if (balance < amount)
			revert ERC1155InsufficientBalance(from, balance, amount, id);

		_burn(from, id, amount);
	}

	function tokenBalance(uint256 id) external view returns (uint256) {
		return _launchpadStorage().tokenSupply[id];
	}

	function _update(
		address from,
		address to,
		uint256[] memory ids,
		uint256[] memory values
	) internal virtual override {
		ERC1155Upgradeable._update(from, to, ids, values);

		LaunchpadStorage storage $ = _launchpadStorage();
		if (from == address(0)) {
			for (uint256 i; i < ids.length; ++i) {
				unchecked {
					$.tokenSupply[ids[i]] += values[i];
				}
			}
		} else if (to == address(0)) {
			for (uint256 i; i < ids.length; ++i) {
				unchecked {
					$.tokenSupply[ids[i]] -= values[i];
				}
			}
		}

		if (from == to) {
			if (to != address(0)) {
				_syncUserCampaignIds(to, ids);
			}
			return;
		}

		if (from != address(0)) {
			_syncUserCampaignIds(from, ids);
		}
		if (to != address(0)) {
			_syncUserCampaignIds(to, ids);
		}
	}

	function _syncUserCampaignIds(address user, uint256[] memory ids) internal {
		LaunchpadStorage storage $ = _launchpadStorage();
		for (uint256 i; i < ids.length; ++i) {
			uint256 id = ids[i];
			if (balanceOf(user, id) == 0) {
				$.userCampaignIds[user].remove(id);
			} else {
				$.userCampaignIds[user].add(id);
			}
		}
	}

	function deployPair() external onlyCampaigns {
		LaunchpadStorage storage $ = _launchpadStorage();
		ICampaign campaign = ICampaign(msg.sender);

		address existingPair = $.campaignPair[address(campaign)];
		if (existingPair != address(0))
			revert PairAlreadyDeployed(address(campaign), existingPair);

		ICampaign.Listing memory listing = campaign.listing();

		address pair = UniswapV2Library.pairFor(
			$.factory,
			listing.campaignToken,
			listing.fundingToken
		);
		address createdPair = IUniswapV2Factory($.factory).createPair(
			listing.campaignToken,
			listing.fundingToken
		);
		if (createdPair == address(0) || createdPair != pair)
			revert PairDeploymentFailed(
				listing.campaignToken,
				listing.fundingToken
			);

		$.campaignPair[address(campaign)] = createdPair;

		uint256 liquidity = IUniswapV2Pair(pair).mint(address(this));
		IERC20(pair).approve($.staking, liquidity);

		IStaking($.staking).stakeLiquidityIn(
			pair,
			liquidity,
			$.fundingTokenToDEDU[listing.fundingToken],
			address(campaign),
			listing.lockEpochs
		);
	}

	function setCampaignMigrator(address migrator) external onlyOwner {
		if (migrator == address(0)) revert ZeroMigrator(migrator);
		_launchpadStorage().campaignMigrator = migrator;
	}

	function campaignMigrator() public view returns (address migrator) {
		return _launchpadStorage().campaignMigrator;
	}

	/*//////////////////////////////////////////////////////////////
	                     PAIR DEPLOYMENT
	//////////////////////////////////////////////////////////////*/
	function _validateListing(
		ICampaign.Listing memory listing,
		uint256 campaignTokenSupply
	) internal view {
		LaunchpadStorage storage $ = _launchpadStorage();

		// --- Basic token checks ---
		if (listing.campaignToken == address(0))
			revert ZeroCampaignToken(listing.campaignToken);
		if (campaignTokenSupply == 0)
			revert ZeroCampaignTokenSupply(campaignTokenSupply);
		if (!$.allowedFundingTokens.contains(listing.fundingToken))
			revert FundingTokenNotAllowed(listing.fundingToken);
		_requireListingContainsWorkToken(listing);

		// --- Funding goal check in DEDU ---
		address[] memory fundingPathToDEDU = $.fundingTokenToDEDU[
			listing.fundingToken
		];
		if (fundingPathToDEDU.length == 0)
			revert NoFundingPathToDEDU(listing.fundingToken);

		uint256 goalDEDUValue;
		if (fundingPathToDEDU.length == 1) {
			goalDEDUValue = listing.goal;
		} else {
			uint256[] memory amountsOut = UniswapV2Library.getAmountsOut(
				$.factory,
				listing.goal,
				fundingPathToDEDU
			);

			goalDEDUValue = amountsOut[amountsOut.length - 1];
		}
		if (goalDEDUValue < TARGET_GOAL_DEDU_VALUE)
			revert InsufficientGoalDEDU(goalDEDUValue, TARGET_GOAL_DEDU_VALUE);

		// --- Deadline & duration checks ---
		if (listing.deadline <= block.timestamp)
			revert InvalidDeadline(listing.deadline, block.timestamp);
		uint256 duration = listing.deadline - block.timestamp;
		if (duration < MIN_DURATION || duration > MAX_DURATION)
			revert InvalidDuration(duration, MIN_DURATION, MAX_DURATION);

		// --- Lock epochs check ---
		if (
			listing.lockEpochs < MIN_LOCK_EPOCHS ||
			listing.lockEpochs > MAX_LOCK_EPOCHS
		)
			revert InvalidLockEpochs(
				listing.lockEpochs,
				MIN_LOCK_EPOCHS,
				MAX_LOCK_EPOCHS
			);

		// --- tokens campaign and listing state
		address pair = IUniswapV2Factory($.factory).getPair(
			listing.fundingToken,
			listing.campaignToken
		);
		address campaign = campaignByTokens(
			listing.fundingToken,
			listing.campaignToken
		);
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
		address wrk = IStaking(_launchpadStorage().staking).workToken();
		if (listing.fundingToken != wrk && listing.campaignToken != wrk)
			revert ListingMustIncludeWorkToken(
				listing.fundingToken,
				listing.campaignToken,
				wrk
			);
	}

	function _validateSecurityPayment(
		uint256[] calldata nonces,
		IGToken gToken,
		address workToken_,
		uint256 currentEpoch
	)
		internal
		view
		returns (IGToken.Balance[] memory balances, uint256[] memory values)
	{
		if (nonces.length == 0) revert NoSecurityTokens();
		balances = _getGTokenBalances(gToken, nonces, msg.sender);

		values = new uint256[](balances.length);
		uint256 totalAmount;
		for (uint256 i; i < nonces.length; ++i) {
			IGToken.Balance memory balance = balances[i];
			if (balance.amount == 0) revert ZeroGTokenBalance(nonces[i]);

			// Ensure GToken epochs are valid
			uint256 epochsLeft = balance.attributes.epochsLeft(currentEpoch);
			if (epochsLeft <= SECURITY_GTOKEN_MIN_EPOCHS_TO_EXPIRE)
				revert SecurityGTokenExpired(
					nonces[i],
					epochsLeft,
					SECURITY_GTOKEN_MIN_EPOCHS_TO_EXPIRE
				);

			// Ensure GToken is LP containing WORK token
			if (!balance.attributes.hasToken(workToken_))
				revert GTokenNotSecurityDeposit(nonces[i], workToken_);

			values[i] = balance.amount;
			totalAmount += balance.amount;
		}

		if (totalAmount < SECURITY_GTOKEN_AMOUNT)
			revert NotEnoughGTokenAmount(totalAmount, SECURITY_GTOKEN_AMOUNT);
	}

	function createCampaign(
		ICampaign.Listing memory listing,
		uint256[] calldata securityNonces,
		uint256 campaignTokenSupply
	) external {
		LaunchpadStorage storage $ = _launchpadStorage();

		_validateListing(listing, campaignTokenSupply);
		(, uint256[] memory values) = _validateSecurityPayment(
			securityNonces,
			IGToken($.gToken),
			IStaking($.staking).workToken(),
			IGToken($.gToken).epochs().currentEpoch()
		);

		(address campaign, ) = _createCampaign(msg.sender, $.gToken, listing);
		_receiveSecurityGToken($, campaign, securityNonces, values);

		IERC20(listing.campaignToken).transferFrom(
			msg.sender,
			campaign,
			campaignTokenSupply
		);
		ICampaign(campaign).resolveCampaign(address(0)); // We're using Zero address since campaign state is transitioning Pending -> Funding

		// Transfer ownership to msg.sender
		Address.functionCall(
			campaign,
			abi.encodeWithSignature("transferOwnership(address)", msg.sender)
		);
	}

	function setTokenPathToDEDU(address[] calldata path) external onlyOwner {
		LaunchpadStorage storage $ = _launchpadStorage();

		if (path.length == 0) revert EmptyPath();

		address dedu = IStaking($.staking).dEDU();

		// Case 1: already DEDU, no swap needed
		if (path.length == 1) {
			if (path[0] != dedu) revert SinglePathMustBeDEDU(path[0], dedu);
		} else {
			// Case 2: multi-hop path ending in DEDU
			address outputToken = path[path.length - 1];
			if (outputToken != dedu)
				revert InvalidOutputToken(outputToken, dedu);

			address _factory = $.factory;

			for (uint256 i; i < path.length - 1; ++i) {
				address pair = IUniswapV2Factory(_factory).getPair(
					path[i],
					path[i + 1]
				);
				if (pair == address(0))
					revert PairDoesNotExist(path[i], path[i + 1]);
			}
		}

		address inputToken = path[0];

		// Below is not required since we can update a token's pathToDEDU
		// require(
		// 	!$.allowedFundingTokens.contains(inputToken),
		// 	"TokenAlreadyAllowed"
		// );

		$.allowedFundingTokens.add(inputToken);
		$.fundingTokenToDEDU[inputToken] = path;
	}

	function removeAllowedFundingToken(address token) external onlyOwner {
		if (token == address(0)) revert ZeroToken(token);

		LaunchpadStorage storage $ = _launchpadStorage();

		if (!$.allowedFundingTokens.contains(token))
			revert TokenNotAllowed(token);

		// Remove from allowed set
		$.allowedFundingTokens.remove(token);

		// Delete swap path to DEDU
		delete $.fundingTokenToDEDU[token];
	}

	/*//////////////////////////////////////////////////////////////
	                 SECURITY GTOKEN HANDLING
	//////////////////////////////////////////////////////////////*/

	function _getGTokenBalances(
		IGToken gToken,
		uint256[] memory nonces,
		address owner
	) internal view returns (IGToken.Balance[] memory balances) {
		uint256 len = nonces.length;

		balances = new IGToken.Balance[](len);
		for (uint256 i; i < len; ++i) {
			balances[i] = gToken.getBalanceAt(owner, nonces[i]);
		}
	}

	function _receiveSecurityGToken(
		LaunchpadStorage storage $,
		address campaign,
		uint256[] calldata nonces,
		uint256[] memory values
	) internal {
		IERC1155($.gToken).safeBatchTransferFrom(
			msg.sender,
			address(this),
			nonces,
			values,
			""
		);
		$.securityNonces[campaign] = nonces;
	}

	function getSecurityGTokens(
		address campaign
	) external view override returns (IGToken.Balance[] memory) {
		LaunchpadStorage storage $ = _launchpadStorage();
		return
			_getGTokenBalances(
				IGToken($.gToken),
				$.securityNonces[campaign],
				address(this)
			);
	}

	function returnSecurityGTokens(address to) external onlyCampaigns {
		LaunchpadStorage storage $ = _launchpadStorage();

		uint256[] memory ids = $.securityNonces[msg.sender];
		delete $.securityNonces[msg.sender];

		uint256 len = ids.length;
		if (len == 0) revert NoSecurityGTokens(msg.sender);

		uint256[] memory values = new uint256[](len);
		for (uint256 i; i < len; ++i) {
			values[i] = ISFT($.gToken).balanceOf(address(this), ids[i]);
		}

		ISFT($.gToken).safeBatchTransferFrom(
			address(this),
			to,
			ids,
			values,
			""
		);
	}

	/*//////////////////////////////////////////////////////////////
	                          VIEWS
	//////////////////////////////////////////////////////////////*/

	function allowedFundingTokens() public view returns (address[] memory) {
		return _launchpadStorage().allowedFundingTokens.values();
	}

	function dEDU() public view returns (address) {
		return IStaking(_launchpadStorage().staking).dEDU();
	}

	function WEDU() public view returns (address) {
		return IStaking(_launchpadStorage().staking).WEDU();
	}

	function workToken() public view returns (address) {
		return IStaking(_launchpadStorage().staking).workToken();
	}

	function factory() public view returns (address) {
		return _launchpadStorage().factory;
	}

	function campaignPair(
		address campaign
	) external view override returns (address) {
		return _launchpadStorage().campaignPair[campaign];
	}

	function userCampaignIds(
		address user
	) external view returns (uint256[] memory) {
		return _launchpadStorage().userCampaignIds[user].values();
	}
}
