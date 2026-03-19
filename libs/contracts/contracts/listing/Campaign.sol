// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/interfaces/IERC1155Receiver.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {ILaunchpad} from "./ILaunchpad.sol";
import {IStaking} from "../staking/IStaking.sol";
import {ICampaign} from "./ICampaign.sol";
import {IGToken} from "../tokens/GToken/IGToken.sol";
import {ISFT} from "../abstracts/ISFT.sol";

import {GTokenLib} from "../tokens/GToken/GTokenLib.sol";

import {FullMath} from "../libraries/FullMath.sol";
import {CampaignLib} from "./CampaignLib.sol";
import {SafeHederaTokenService} from "../vendor/hedera/SafeHederaTokenService.sol";

/// @notice Campaign contract for liquidity / pair launch funding
contract Campaign is
    ICampaign,
    Initializable,
    OwnableUpgradeable,
    IERC1155Receiver,
    SafeHederaTokenService
{
    using GTokenLib for IGToken.Attributes;

    /*//////////////////////////////////////////////////////////////
	                           TYPES
	//////////////////////////////////////////////////////////////*/

    address private _launchpad;
    address private _gToken;
    Status public override status;
    Listing private _listing;

    constructor() {
        _disableInitializers();
    }

    function initialize(
        address launchpad_,
        address gToken_,
        Listing memory listing_,
        address initialOwner
    ) external initializer {
        __Ownable_init(initialOwner);
        _initialize(launchpad_, gToken_, listing_);
    }

    function _initialize(
        address launchpad_,
        address gToken_,
        Listing memory listing_
    ) internal {
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

        _launchpad = launchpad_;
        _gToken = gToken_;
        _listing = listing_;
        status = Status.Pending;

        address[] memory tokens = new address[](2);
        tokens[0] = _listing.fundingToken;
        tokens[1] = _listing.campaignToken;
        _safeAssociateTokens(address(this), tokens);
    }

    /*//////////////////////////////////////////////////////////////
	                           MODIFIERS
	//////////////////////////////////////////////////////////////*/

    modifier notExpired() {
        uint256 deadline = _listing.deadline;
        if (block.timestamp > deadline)
            revert CampaignExpired(deadline, block.timestamp);
        _;
    }

    modifier inStatus(Status expected) {
        if (status != expected) revert InvalidStatus(expected, status);
        _;
    }

    /*//////////////////////////////////////////////////////////////
	                       CORE LOGIC
	//////////////////////////////////////////////////////////////*/
    function _contribute(uint256 amount, address user) internal {
        if (amount == 0) revert ZeroContribution(amount);

        ILaunchpad(_launchpad).mint(user, amount);
        emit ContributionMade(user, amount);
    }

    function contribute(
        uint256 amount,
        address to
    ) external notExpired inStatus(Status.Funding) {
        IERC20(_listing.fundingToken).transferFrom(
            msg.sender,
            address(this),
            amount
        );

        _contribute(amount, to);
    }

    function contributeHbar(
        address to
    ) external payable notExpired inStatus(Status.Funding) {
        if (msg.value == 0) revert ZeroContribution(msg.value);

        IStaking staking = IStaking(ILaunchpad(_launchpad).staking());
        address whbarToken = staking.whbarToken();

        Listing memory listing_ = _listing;
        require(whbarToken == listing_.fundingToken, "Funding not HBAR");

        uint256 balanceBefore = IERC20(whbarToken).balanceOf(address(this));
        (bool success, ) = staking.whbar().call{value: msg.value}(
            abi.encodeWithSignature("deposit()")
        );
        if (!success) revert WrappedNativeDepositFailed(whbarToken, msg.value);

        uint256 balanceAfter = IERC20(whbarToken).balanceOf(address(this));
        uint256 amount = balanceAfter - balanceBefore;
        if (amount == 0) revert ZeroContribution(amount);

        _contribute(amount, to);
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

        // Campaign must be completed successfully
        if (block.timestamp < _listing.deadline)
            revert CampaignNotEnded(_listing.deadline, block.timestamp);
        if (status != Status.Success) revert CampaignNotSuccess(status);

        /* The check for contributionBal > 0 and the successfull
         * burn of contribution from msg.sender is suffcient to ensure
         * contribution <= contribution bal since in ILaunchpad.burn
         * balanceOf(msg.sender, tokenID(this)) >= 0 contribution is checked
         */
        uint256 contributionBal = ILaunchpad(_launchpad).tokenBalance(
            CampaignLib.tokenId(address(this))
        );
        if (contributionBal == 0) revert ContributionsDrained(contributionBal);
        // Burn claim token
        ILaunchpad(_launchpad).burn(msg.sender, contribution);

        IGToken.Balance memory gTokenBalance = _getLisitngGToken(
            IGToken(_gToken)
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

        (, uint256[] memory splitIds) = ISFT(_gToken).splitTransferFrom(
            address(this),
            gTokenBalance.nonce,
            recipients,
            portions
        );

        gTokenNonce = splitIds[0];
    }

    function _refund(uint256 contribution, address to) internal {
        if (contribution == 0) revert ZeroContribution(contribution);

        if (block.timestamp < _listing.deadline)
            revert CampaignNotEnded(_listing.deadline, block.timestamp);

        // Resolve status lazily
        if (status == Status.Funding) {
            if (fundingSupply() < _listing.goal) {
                status = Status.Failed;
            } else {
                revert CampaignSucceeded(fundingSupply(), _listing.goal);
            }
        }

        if (status != Status.Failed) revert CampaignNotFailed(status);

        ILaunchpad(_launchpad).burn(msg.sender, contribution);
        IERC20(_listing.fundingToken).transfer(to, contribution);
    }

    function deployLiquidity() public inStatus(Status.Funding) {
        Listing memory listing_ = _listing;

        if (block.timestamp < listing_.deadline) {
            revert CampaignNotEnded(listing_.deadline, block.timestamp);
        }

        if (listing_.goal == 0 || fundingSupply() < listing_.goal)
            revert GoalNotReached(listing_.goal, fundingSupply());

        address launchpad = _launchpad;
        address pair = ILaunchpad(launchpad).campaignPair(address(this));
        if (pair == address(0))
            revert ILaunchpad.PairNotDeployed(address(this));

        IERC20(listing_.campaignToken).transfer(pair, campaignSupply());
        IERC20(listing_.fundingToken).transfer(pair, fundingSupply());
        ILaunchpad(launchpad).stakeCampaignPair();

        status = Status.Success;
    }

    function _resolveFromFunding() internal returns (Status) {
        Listing memory listing_ = _listing;

        if (block.timestamp < listing_.deadline) {
            return status;
        }

        if (fundingSupply() >= listing_.goal) {
            deployLiquidity();
            return status;
        }

        return Status.Failed;
    }

    function resolveCampaign(
        address to
    ) external onlyOwner returns (Status) {
        Status currentStatus = status;

        if (currentStatus == Status.Pending) {
            uint256 campaignTokens = campaignSupply();
            if (campaignTokens == 0)
                revert MissingCampaignTokens(campaignTokens);
            status = Status.Funding;
            return status;
        }

        if (to == address(0)) revert ZeroAddress(to);

        // Init next status
        Status _nS = currentStatus == Status.Funding
            ? _resolveFromFunding()
            : currentStatus;

        bool isFinalStatus = _nS == Status.Success || _nS == Status.Failed;
        if (!isFinalStatus) revert InvalidFinalStatus(_nS);

        Listing memory listing_ = _listing;

        // Refund campaign tokens on failure
        if (_nS == Status.Failed) {
            uint256 campaignFunds = campaignSupply();
            if (campaignFunds > 0) {
                IERC20(listing_.campaignToken).transfer(to, campaignFunds);
            }
        }

        status = _nS;
        return status;
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
        if (msg.sender != _gToken) revert UnauthorizedGToken();
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
        IGToken gToken = IGToken(_gToken);
        Listing memory l = _listing;

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
            ISFT(_gToken).mergeTransferFrom(
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

    function fundingSupply() public view returns (uint256) {
        return IERC20(_listing.fundingToken).balanceOf(address(this));
    }

    function campaignSupply() public view returns (uint256) {
        return IERC20(_listing.campaignToken).balanceOf(address(this));
    }

    function listing() public view returns (Listing memory) {
        return _listing;
    }

    uint256[50] private __gap;
}
