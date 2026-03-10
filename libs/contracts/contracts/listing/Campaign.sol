// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/interfaces/IERC1155.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/interfaces/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ILaunchpad} from "./ILaunchpad.sol";
import {Launchpad} from "./Launchpad.sol";
import {ICampaign} from "./ICampaign.sol";
import {IGToken} from "../tokens/GToken/IGToken.sol";
import {ISFT} from "../abstracts/ISFT.sol";

import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";

import {FullMath} from "../libraries/FullMath.sol";
import {UniswapV2Library} from "../libraries/UniswapV2Library.sol";
import {CampaignLib} from "./CampaignLib.sol";

interface IWEDU {
	function deposit() external payable;
}

/// @notice Campaign contract for liquidity / pair launch funding
contract Campaign is ICampaign, OwnableUpgradeable, IERC1155Receiver {
	using GTokenLib for IGToken.Attributes;

	/*//////////////////////////////////////////////////////////////
	                           TYPES
	//////////////////////////////////////////////////////////////*/

	/// @custom:storage-location erc7201:workit.contracts.listing.Campaign
	struct CampaignStorage {
		address launchpad;
		address gToken;
		Status status;
		Listing listing;
	}

	/*//////////////////////////////////////////////////////////////
	                       ERC-7201 STORAGE
	//////////////////////////////////////////////////////////////*/

	// keccak256("workit.contracts.listing.Campaign") & ~bytes32(uint256(0xff))
	bytes32 internal constant CAMPAIGN_STORAGE_LOCATION =
		0xa4955760aaa83777c8c17bdf4c3e664a0aca921e84a3064328444ba0bd380400;

	function _campaignStorage()
		internal
		pure
		returns (CampaignStorage storage $)
	{
		assembly {
			$.slot := CAMPAIGN_STORAGE_LOCATION
		}
	}

	function initialize(
		address launchpad_,
		address gToken_,
		Listing memory listing_
	) external initializer {
		// --- basic infra checks ---
		if (launchpad_ == address(0)) revert ZeroLaunchpad(launchpad_);
		if (gToken_ == address(0)) revert ZeroGToken(gToken_);

		// --- listing checks ---
		if (listing_.fundingToken == address(0))
			revert ZeroFundingToken(listing_.fundingToken);
		if (listing_.campaignToken == address(0))
			revert ZeroCampaignToken(listing_.campaignToken);
		if (listing_.goal == 0) revert ZeroGoal(listing_.goal);

		// Optional but strongly recommended
		if (listing_.fundingToken == listing_.campaignToken)
			revert IdenticalTokens(
				listing_.fundingToken,
				listing_.campaignToken
			);

		__Ownable_init(msg.sender);

		CampaignStorage storage $ = _campaignStorage();

		$.launchpad = launchpad_;
		$.gToken = gToken_;
		$.listing = listing_;
		$.status = Status.Pending;
	}

	/*//////////////////////////////////////////////////////////////
	                           MODIFIERS
	//////////////////////////////////////////////////////////////*/

	modifier notExpired() {
		uint256 deadline = listing().deadline;
		if (block.timestamp > deadline)
			revert CampaignExpired(deadline, block.timestamp);
		_;
	}

	modifier inStatus(Status expected) {
		CampaignStorage storage $ = _campaignStorage();
		if ($.status != expected) revert InvalidStatus(expected, $.status);
		_;
	}

	/*//////////////////////////////////////////////////////////////
	                       CORE LOGIC
	//////////////////////////////////////////////////////////////*/
	function _contribute(
		uint256 amount,
		address user,
		address launchpad
	) internal {
		if (amount == 0) revert ZeroContribution(amount);

		ILaunchpad(launchpad).mint(user, amount);
		emit ContributionMade(user, amount);
	}

	function _checkDEDUFunding(
		address dedu,
		address fundingToken
	) internal pure returns (address) {
		if (dedu != fundingToken)
			revert InvalidFundingToken(fundingToken, dedu);
		return dedu;
	}

	function contribute(
		uint256 amount,
		address to
	) external notExpired inStatus(Status.Funding) {
		CampaignStorage storage $ = _campaignStorage();

		IERC20($.listing.fundingToken).transferFrom(
			msg.sender,
			address(this),
			amount
		);

		_contribute(amount, to, $.launchpad);
	}

	function contribute(
		address to
	) external payable notExpired inStatus(Status.Funding) {
		CampaignStorage storage $ = _campaignStorage();
		address dedu = _checkDEDUFunding(
			ILaunchpad($.launchpad).dEDU(),
			$.listing.fundingToken
		);
		address wedu = ILaunchpad($.launchpad).WEDU();
		if (dedu != wedu) revert InvalidFundingToken(wedu, dedu);

		IWEDU(wedu).deposit{value: msg.value}();
		_contribute(msg.value, to, $.launchpad);
	}

	function contributeWEDU(
		uint256 amount,
		address to
	) external notExpired inStatus(Status.Funding) {
		CampaignStorage storage $ = _campaignStorage();
		address dedu = _checkDEDUFunding(
			ILaunchpad($.launchpad).dEDU(),
			$.listing.fundingToken
		);
		address wedu = ILaunchpad($.launchpad).WEDU();
		if (dedu != wedu) revert InvalidFundingToken(wedu, dedu);

		IERC20(wedu).transferFrom(msg.sender, address(this), amount);
		_contribute(amount, to, $.launchpad);
	}

	function _getLisitngGToken(
		IGToken gToken
	) internal view returns (IGToken.Balance memory balance) {
		IGToken.Balance[] memory balances = gToken.getBalance(address(this));

		// since on receipt of IERC1155 we merge all gTokens and we accept only lisiting gTokens,
		// we expect this contract to hold only one listing gToken
		if (balances.length > 0) {
			return balances[0];
		}
	}

	function _redeem(
		uint256 contribution,
		address to
	) internal returns (uint256 gTokenNonce, uint256 userLiqShare) {
		if (contribution == 0) revert ZeroContribution(contribution);

		CampaignStorage storage $ = _campaignStorage();

		// Campaign must be completed successfully
		if (block.timestamp < $.listing.deadline)
			revert CampaignNotEnded($.listing.deadline, block.timestamp);
		if ($.status != Status.Success) revert CampaignNotSuccess($.status);

		/* The check for contributionBal > 0 and the successfull
		 * burn of contribution from msg.sender is suffcient to ensure
		 * contribution <= contribution bal since in ILaunchpad.burn
		 * balanceOf(msg.sender, tokenID(this)) >= 0 contribution is checked
		 */
		uint256 contributionBal = ILaunchpad($.launchpad).tokenBalance(
			CampaignLib.tokenId(address(this))
		);
		if (contributionBal == 0) revert ContributionsDrained(contributionBal);
		// Burn claim token
		ILaunchpad($.launchpad).burn(msg.sender, contribution);

		IGToken.Balance memory gTokenBalance = _getLisitngGToken(
			IGToken($.gToken)
		);
		if (gTokenBalance.amount == 0) revert NoLiquidity(gTokenBalance.amount);

		// Pro-rata share
		userLiqShare = FullMath.mulDiv(
			contribution,
			gTokenBalance.amount,
			contributionBal
		);

		// Transfer user's liquidity share
		address[] memory recipients = new address[](1);
		uint256[] memory portions = new uint256[](1);
		recipients[0] = to;
		portions[0] = userLiqShare;

		(, uint256[] memory splitIds) = ISFT($.gToken).splitTransferFrom(
			address(this),
			gTokenBalance.nonce,
			recipients,
			portions
		);

		gTokenNonce = splitIds[0];
	}

	function _refund(uint256 contribution, address to) internal {
		if (contribution == 0) revert ZeroContribution(contribution);

		CampaignStorage storage $ = _campaignStorage();

		if (block.timestamp < $.listing.deadline)
			revert CampaignNotEnded($.listing.deadline, block.timestamp);

		// Resolve status lazily
		if ($.status == Status.Funding) {
			if (fundingSupply() < $.listing.goal) {
				$.status = Status.Failed;
			} else {
				revert CampaignSucceeded(fundingSupply(), $.listing.goal);
			}
		}

		if ($.status != Status.Failed) revert CampaignNotFailed($.status);

		ILaunchpad($.launchpad).burn(msg.sender, contribution);
		IERC20($.listing.fundingToken).transfer(to, contribution);
	}

	function deployPair() public inStatus(Status.Funding) {
		CampaignStorage storage $ = _campaignStorage();
		Listing memory _listing = $.listing;

		if (block.timestamp < _listing.deadline) {
			revert CampaignNotEnded(_listing.deadline, block.timestamp);
		}

		if (_listing.goal == 0 || fundingSupply() < _listing.goal)
			revert GoalNotReached(_listing.goal, fundingSupply());

		address launchpad = $.launchpad;
		address pair = UniswapV2Library.pairFor(
			Launchpad(launchpad).factory(),
			_listing.campaignToken,
			_listing.fundingToken
		);

		IERC20(_listing.campaignToken).transfer(pair, campaignSupply());
		IERC20(_listing.fundingToken).transfer(pair, fundingSupply());

		ILaunchpad(launchpad).deployPair();

		$.status = Status.Success;
	}

	function _resolveFromFunding() internal returns (Status) {
		CampaignStorage storage $ = _campaignStorage();
		Listing memory _listing = $.listing;

		if (block.timestamp < _listing.deadline) {
			return $.status;
		}

		if (fundingSupply() >= _listing.goal) {
			deployPair();
			return Status.Success;
		}

		return Status.Failed;
	}

	function resolveCampaign(address to) external onlyOwner returns (Status) {
		CampaignStorage storage $ = _campaignStorage();
		Status currentStatus = $.status;

		if (currentStatus == Status.Pending) {
			uint256 securityCount = ILaunchpad($.launchpad)
				.getSecurityGTokens(address(this))
				.length;
			uint256 campaignTokens = campaignSupply();
			if (securityCount == 0 || campaignTokens == 0)
				revert MissingCampaignTokens(securityCount, campaignTokens);
			$.status = Status.Funding;
			return $.status;
		}

		if (to == address(0)) revert ZeroAddress(to);

		// Init next status
		Status _nS = currentStatus == Status.Funding
			? _resolveFromFunding()
			: currentStatus;

		bool isFinalStatus = _nS == Status.Success || _nS == Status.Failed;
		if (!isFinalStatus) revert InvalidFinalStatus(_nS);

		Listing memory _listing = $.listing;

		ILaunchpad($.launchpad).returnSecurityGTokens(to);

		// Refund campaign tokens on failure
		if (_nS == Status.Failed) {
			uint256 campaignFunds = campaignSupply();
			if (campaignFunds > 0) {
				IERC20(_listing.campaignToken).transfer(to, campaignFunds);
			}
		}

		$.status = _nS;
		return $.status;
	}

	function redeemContribution(
		uint256 contribution,
		address to
	) external returns (uint256 gTokenNonce, uint256 userLiqShare) {
		if (to == address(0)) revert ZeroAddress(to);
		return _redeem(contribution, to);
	}

	function refundContribution(uint256 contribution, address to) external {
		if (to == address(0)) revert ZeroAddress(to);
		_refund(contribution, to);
	}

	/*//////////////////////////////////////////////////////////////
                         GTOKEN HANDLING
    //////////////////////////////////////////////////////////////*/

	modifier onlyGToken() {
		if (msg.sender != _campaignStorage().gToken)
			revert UnauthorizedGToken();
		_;
	}

	/// @dev ERC165 support
	function supportsInterface(
		bytes4 interfaceId
	) external pure override returns (bool) {
		return
			interfaceId == type(IERC1155Receiver).interfaceId ||
			interfaceId == type(IERC165).interfaceId;
	}

	function onERC1155Received(
		address /* operator */,
		address /* from */,
		uint256 /* id */,
		uint256 /* value */,
		bytes calldata /* data */
	) external override onlyGToken returns (bytes4) {
		_tryMergeListingGTokens();

		return this.onERC1155Received.selector;
	}

	function onERC1155BatchReceived(
		address /* operator */,
		address /* from */,
		uint256[] calldata /* ids */,
		uint256[] calldata /* values */,
		bytes calldata /* data */
	) external override onlyGToken returns (bytes4) {
		_tryMergeListingGTokens();
		return this.onERC1155BatchReceived.selector;
	}

	/// @dev Merge ALL listing GTokens held by this contract, ignoring security nonces and other nonces by reverting.
	///      Uses FIFO discovery for the "anchor" nonce.
	function _tryMergeListingGTokens() internal {
		CampaignStorage storage $ = _campaignStorage();
		IGToken gToken = IGToken($.gToken);
		Listing memory l = $.listing;

		IGToken.Balance[] memory balances = gToken.getBalance(address(this));
		if (balances.length == 0) return;

		// Find all listing nonces (non-security) with amount > 0
		// We’ll collect in a temp array of max size balances.length
		uint256[] memory mergeIds = new uint256[](balances.length);
		uint256 count = 0;

		for (uint256 i; i < balances.length; ) {
			IGToken.Balance memory bal = balances[i];

			// Must match listing pair
			if (!bal.attributes.hasToken(l.fundingToken))
				revert InvalidListingGTokenNonce(bal.nonce);
			if (!bal.attributes.hasToken(l.campaignToken))
				revert InvalidListingGTokenNonce(bal.nonce);

			mergeIds[count++] = bal.nonce;

			unchecked {
				++i;
			}
		}

		// Nothing or only one listing nonce -> nothing to merge
		if (count <= 1) return;

		// Build exact-length merge array;
		// anchor already at mergeIds[0])

		// Merge all into one nonce held by this contract
		// We do strict revert on failure.
		try
			ISFT($.gToken).mergeTransferFrom(
				address(this),
				address(this),
				mergeIds
			)
		returns (uint256) {
			// ok
		} catch {
			revert MergeFailed();
		}
	}

	/*//////////////////////////////////////////////////////////////
	                      VIEW HELPERS
	//////////////////////////////////////////////////////////////*/

	function status() public view returns (Status) {
		return _campaignStorage().status;
	}

	function fundingSupply() public view returns (uint256) {
		return IERC20(listing().fundingToken).balanceOf(address(this));
	}

	function campaignSupply() public view returns (uint256) {
		return IERC20(listing().campaignToken).balanceOf(address(this));
	}

	function listing() public view returns (Listing memory) {
		return _campaignStorage().listing;
	}
}
