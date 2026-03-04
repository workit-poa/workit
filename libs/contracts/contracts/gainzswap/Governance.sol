// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC1155HolderUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/utils/ERC1155HolderUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {TokenPayment, TokenPayments} from "./libraries/TokenPayments.sol";
import {OracleLibrary} from "./libraries/OracleLibrary.sol";
import {FixedPoint128} from "./libraries/FixedPoint128.sol";
import {FullMath} from "./uniswap-v2/libraries/FullMath.sol";
import {Number} from "./libraries/Number.sol";
import {Epochs} from "./libraries/Epochs.sol";
import "./libraries/utils.sol";

import {GToken, GTokenLib} from "./tokens/GToken/GToken.sol";
import {IGToken} from "./tokens/GToken/IGToken.sol";
import {Gainz} from "./tokens/Gainz/Gainz.sol";
import {IStaking} from "./staking/IStaking.sol";
import {IUniswapV2Factory} from "./uniswap-v2/interfaces/IUniswapV2Factory.sol";
import {UniswapV2Library} from "./uniswap-v2/libraries/UniswapV2Library.sol";

import {Pair} from "./Pair.sol";
import {Router} from "./Router.sol";
import {PriceOracle} from "./PriceOracle.sol";
import {LaunchPair} from "./LaunchPair.sol";
import {DEDU} from "./tokens/dEDU/dEDU.sol";
import {IGovernance} from "./interfaces/IGovernance.sol";

import "./errors.sol";

/// @title Governance Contract
/// @notice This contract handles the governance process by allowing users to lock GToken tokens and mint GTokens.
/// @dev This contract interacts with the GTokens library and manages GToken token payments.
contract Governance is
	ERC1155HolderUpgradeable,
	OwnableUpgradeable,
	Errors,
	IGovernance
{
	using Epochs for Epochs.Storage;
	using GTokenLib for IGToken.Attributes;
	using TokenPayments for TokenPayment;
	using TokenPayments for address;
	using EnumerableSet for EnumerableSet.AddressSet;
	using EnumerableSet for EnumerableSet.UintSet;
	using Number for uint256;

	struct TokenListing {
		uint256 yesVote; // Number of yes votes
		uint256 noVote; // Number of no votes
		uint256 totalGTokenAmount; // Total GToken amount locked for the listing
		uint256 endEpoch; // Epoch when the listing proposal ends
		address owner; // The owner proposing the listing
		TokenPayment securityGTokenPayment;
		TokenPayment tradeTokenPayment; // The token proposed for trading
		uint256 campaignId; // launchPair campaign ID
	}

	/// @custom:storage-location erc7201:gainz.Governance.storage
	struct GovernanceStorage {
		uint256 rewardPerShare;
		uint256 rewardsReserve;
		// The following values should be immutable
		address gtoken;
		address gainzToken;
		address router;
		address wNativeToken;
		Epochs.Storage epochs;
		// New vars after adding launchpair
		uint256 protocolFees;
		address protocolFeesCollector;
		mapping(address => EnumerableSet.UintSet) userVotes;
		mapping(address => address) userVote;
		TokenListing activeListing;
		EnumerableSet.AddressSet pendingOrListedTokens;
		mapping(address => TokenListing) pairOwnerListing;
		LaunchPair launchPair;
		mapping(address => uint) pairLiqFee;
		IStaking staking;
	}

	// keccak256(abi.encode(uint256(keccak256("gainz.Governance.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant GOVERNANCE_STORAGE_LOCATION =
		0x8a4dda5430cdcd8aca8f2a075bbbae5f31557dc6b6b93555c9c43f674de00c00;

	function _getGovernanceStorage()
		private
		pure
		returns (GovernanceStorage storage $)
	{
		assembly {
			$.slot := GOVERNANCE_STORAGE_LOCATION
		}
	}

	/// @notice Initializes the core Governance contract.
	/// @dev Sets essential tokens only; other critical configuration handled separately
	/// @param gainzToken Address of the Gainz ERC20 token
	/// @param wNativeToken Address of the wrapped native token (e.g., WETH, WBNB)
	function initialize(
		address gainzToken,
		address wNativeToken
	) public initializer {
		// Set deployer as owner
		__Ownable_init(msg.sender);

		GovernanceStorage storage $ = _getGovernanceStorage();

		// Set wrapped native token
		require(
			wNativeToken != address(0),
			"Governance: INVALID_WRAPPED_NATIVE_TOKEN"
		);
		$.wNativeToken = wNativeToken;

		// Set Gainz token
		require(gainzToken != address(0), "Governance: INVALID_GAINZ_TOKEN");
		$.gainzToken = gainzToken;
	}

	/// @custom:oz-upgrades-validate-as-initializer
	function initializeV2(address _owner) public reinitializer(2) {
		__Ownable_init(_owner);
	}

	/// @notice Configures the router, GToken, and LaunchPair
	/// @notice Configures the router, GToken, and LaunchPair
	/// @dev Can be called only once to prevent accidental overwrites
	/// @param gToken_ Address of the GToken contract (must not be zero)
	/// @param launchPair_ Address of the LaunchPair contract (must not be zero)
	/// @param router_ Address of the router (must not be zero)
	function configure(
		address gToken_,
		address launchPair_,
		address router_
	) external onlyOwner {
		GovernanceStorage storage $ = _getGovernanceStorage();

		// Ensure configuration has not been set before
		require($.gtoken == address(0), "Governance: GTOKEN_ALREADY_SET");
		require(
			address($.launchPair) == address(0),
			"Governance: LAUNCHPAIR_ALREADY_SET"
		);
		require($.router == address(0), "Governance: ROUTER_ALREADY_SET");

		// Validate inputs
		require(gToken_ != address(0), "Governance: INVALID_GTOKEN");
		require(launchPair_ != address(0), "Governance: INVALID_LAUNCHPAIR");
		require(router_ != address(0), "Governance: INVALID_ROUTER");

		// Set router
		$.router = router_;

		// Set GToken and LaunchPair
		$.gtoken = gToken_;
		$.launchPair = LaunchPair(payable(launchPair_));

		// Initialize epochs (e.g., governance voting periods)
		$.epochs.initialize(24 hours);
	}

	function setStaking(address staking) external onlyOwner {
		require(staking != address(0), "invalid staking address");
		_getGovernanceStorage().staking = IStaking(staking);
	}

	function _ensureNewPair(
		GovernanceStorage storage $,
		address token0,
		address token1
	) internal returns (address newPair) {
		IUniswapV2Factory newFactory = IUniswapV2Factory(
			Router(payable($.router)).factory()
		);

		if (newFactory.getPair(token0, token1) == address(0)) {
			newFactory.createPair(token0, token1);
		}

		newPair = newFactory.getPair(token0, token1);
		require(
			UniswapV2Library.pairFor(address(newFactory), token0, token1) ==
				newPair,
			"Pair address missmatch"
		);
	}

	function _addLiquidity(
		GovernanceStorage storage $,
		address token0,
		address token1,
		uint256 amount0Desired,
		uint256 amount1Desired,
		uint256 amount0Min,
		uint256 amount1Min,
		address to
	) internal returns (uint256 amount0, uint256 amount1, uint256 liquidity) {
		address pair = IUniswapV2Factory(Router(payable($.router)).factory())
			.getPair(token0, token1);
		require(pair != address(0), "Governance: PAIR_NOT_EXISTS");

		(amount0, amount1, liquidity) = Router(payable($.router)).addLiquidity(
			token0,
			token1,
			amount0Desired,
			amount1Desired,
			amount0Min,
			amount1Min,
			to,
			block.timestamp + 1
		);

		$.staking.pokeOracle(pair);
	}

	function migratePairLiqFee(
		address pair,
		MigrateLiqVar memory migrateVar
	) external onlyOwner {
		GovernanceStorage storage $ = _getGovernanceStorage();

		address token0 = Pair(pair).token0();
		address token1 = Pair(pair).token1();

		_ensureNewPair($, token0, token1);

		uint256 liquidity = $.pairLiqFee[pair];
		if (liquidity == 0) return;

		$.pairLiqFee[pair] = 0;

		(uint256 amount0, uint256 amount1) = _removeLiquidityOldPair(
			$,
			address(this),
			liquidity,
			token0,
			token1,
			migrateVar.removeAmount0Min,
			migrateVar.removeAmount1Min
		);

		IERC20(token0).approve(address($.router), amount0);
		IERC20(token1).approve(address($.router), amount1);

		_addLiquidity(
			$,
			token0,
			token1,
			amount0,
			amount1,
			migrateVar.addAmount0Min,
			migrateVar.addAmount1Min,
			address(this)
		);

		emit PairLiqFeeMigrated(pair, liquidity, amount0, amount1);
	}

	function _calculateClaimableReward(
		address user,
		uint256[] memory nonces,
		address gtoken,
		uint256 rewardPerShare_
	)
		internal
		view
		returns (
			uint256 claimableReward,
			IGToken.Attributes[] memory attributes
		)
	{
		attributes = new IGToken.Attributes[](nonces.length);

		for (uint256 i = 0; i < nonces.length; i++) {
			attributes[i] = GToken(gtoken)
				.getBalanceAt(user, nonces[i])
				.attributes;

			// Fix incorrect distribution of gainzILODeposit
			uint256 tokenRPS = attributes[i].rewardPerShare;
			uint256 rpsDiff = rewardPerShare_ >= tokenRPS
				? rewardPerShare_ - tokenRPS
				: rewardPerShare_;

			claimableReward += FullMath.mulDiv(
				attributes[i].stakeWeight,
				rpsDiff,
				FixedPoint128.Q128
			);
		}
	}

	function _claimRewards(
		GovernanceStorage storage $,
		address user,
		uint256[] memory nonces
	)
		internal
		returns (
			uint256 claimableReward,
			IGToken.Attributes[] memory attributes
		)
	{
		(claimableReward, attributes) = _calculateClaimableReward(
			user,
			nonces,
			$.gtoken,
			$.rewardPerShare
		);

		if (claimableReward > 0) {
			$.rewardsReserve -= claimableReward;
			IERC20($.gainzToken).transfer(user, claimableReward);
		}
	}

	struct EarlyUnlockPenalty {
		uint256 liquidityToReturn;
		uint256 amount0MinAdjusted;
		uint256 amount1MinAdjusted;
		uint256 liqFee;
	}

	function _migrateStake(
		GovernanceStorage storage $,
		IGToken.Attributes memory attribute,
		MigrateLiqVar memory migrateVar,
		address[] calldata pathToDEDU
	) internal {
		address newPair;
		uint256 liquidity;

		{
			// Get liquidity
			address token0 = attribute.lpDetails.token0;
			address token1 = attribute.lpDetails.token1;
			newPair = _ensureNewPair($, token0, token1);

			(
				migrateVar.removeAmount0Min,
				migrateVar.removeAmount1Min
			) = _removeLiquidityOldPair(
				$,
				address(this),
				attribute.lpDetails.liquidity,
				token0,
				token1,
				migrateVar.removeAmount0Min,
				migrateVar.removeAmount1Min
			);

			IERC20(token0).approve(
				address($.router),
				migrateVar.removeAmount0Min
			);
			IERC20(token1).approve(
				address($.router),
				migrateVar.removeAmount1Min
			);

			(, , liquidity) = _addLiquidity(
				$,
				token0,
				token1,
				migrateVar.removeAmount0Min,
				migrateVar.removeAmount1Min,
				migrateVar.addAmount0Min,
				migrateVar.addAmount1Min,
				address(this)
			);
		}

		IERC20(newPair).approve(address($.staking), liquidity);
		$.staking.stakeLiquidityIn(
			newPair,
			liquidity,
			pathToDEDU,
			msg.sender,
			attribute.epochsLeft($.epochs.currentEpoch())
		);
	}

	function claimRewards(
		uint256[] memory nonces,
		MigrateLiqVar memory migrateVar,
		address[] calldata pathToDEDU
	) external returns (uint256[] memory) {
		GovernanceStorage storage $ = _getGovernanceStorage();

		(, IGToken.Attributes[] memory attributes) = _claimRewards(
			$,
			msg.sender,
			nonces
		);

		for (uint256 i; i < nonces.length; ++i) {
			IGToken.Attributes memory attribute = attributes[i];

			GToken($.gtoken).burn(msg.sender, nonces[i], attribute.supply());

			_migrateStake($, attribute, migrateVar, pathToDEDU);
		}

		return nonces;
	}

	function unStake(
		uint256[] calldata nonces,
		uint256[] calldata amount0Mins,
		uint256[] calldata amount1Mins
	) external {
		GovernanceStorage storage $ = _getGovernanceStorage();

		address user = msg.sender;
		uint256 len = nonces.length;
		require(
			amount0Mins.length == len && amount1Mins.length == len,
			"Governance: LENGTH_MISMATCH"
		);

		(, IGToken.Attributes[] memory attributes) = _claimRewards(
			$,
			user,
			nonces
		);
		uint256 currentEpoch = $.epochs.currentEpoch();

		for (uint256 i; i < len; ) {
			IGToken.Attributes memory attribute = attributes[i];
			uint256 nonce = nonces[i];

			// Burn user’s GToken position
			GToken($.gtoken).burn(user, nonce, attribute.supply());

			EarlyUnlockPenalty memory penalty = _computeEarlyUnlockPenalty(
				attribute,
				amount0Mins[i],
				amount1Mins[i],
				currentEpoch
			);

			if (penalty.liqFee > 0) {
				$.pairLiqFee[attribute.lpDetails.pair] += penalty.liqFee;
			}

			_removeLiquidityOldPair(
				$,
				user,
				penalty.liquidityToReturn,
				attribute.lpDetails.token0,
				attribute.lpDetails.token1,
				penalty.amount0MinAdjusted,
				penalty.amount1MinAdjusted
			);

			unchecked {
				++i;
			}
		}
	}

	/// @notice Computes liquidity and min amounts after early unlock penalty (stateful)
	function _computeEarlyUnlockPenalty(
		IGToken.Attributes memory attr,
		uint256 amount0Min,
		uint256 amount1Min,
		uint256 currentEpoch
	) internal pure returns (EarlyUnlockPenalty memory penalty) {
		uint256 liquidity = attr.lpDetails.liquidity;

		penalty.liquidityToReturn = attr.epochsLocked == 0
			? liquidity
			: attr.valueToKeep(liquidity, currentEpoch);

		if (penalty.liquidityToReturn < liquidity) {
			penalty.liqFee = liquidity - penalty.liquidityToReturn;
			penalty.amount0MinAdjusted =
				(amount0Min * penalty.liquidityToReturn) /
				liquidity;
			penalty.amount1MinAdjusted =
				(amount1Min * penalty.liquidityToReturn) /
				liquidity;
		} else {
			penalty.amount0MinAdjusted = amount0Min;
			penalty.amount1MinAdjusted = amount1Min;
		}
	}

	/// @notice View-only getter: returns liquidity after penalty for a list of nonces
	function getLiquidityAfterPenalty(
		uint256[] memory nonces,
		uint256[] memory amounts0Min,
		uint256[] memory amounts1Min
	)
		external
		view
		returns (
			uint256[] memory liquidities,
			uint256[] memory adjusted0Min,
			uint256[] memory adjusted1Min
		)
	{
		if (
			nonces.length != amounts0Min.length ||
			nonces.length != amounts1Min.length
		) revert("Governance: LENGTH_MISMATCH");

		GovernanceStorage storage $ = _getGovernanceStorage();
		IGToken gToken = IGToken($.gtoken);
		uint256 currentEpoch = $.epochs.currentEpoch();

		liquidities = new uint256[](nonces.length);
		adjusted0Min = new uint256[](nonces.length);
		adjusted1Min = new uint256[](nonces.length);

		for (uint256 i; i < nonces.length; ++i) {
			IGToken.Attributes memory attr = gToken.getAttributes(nonces[i]);

			EarlyUnlockPenalty memory penalty = _computeEarlyUnlockPenalty(
				attr,
				amounts0Min[i],
				amounts1Min[i],
				currentEpoch
			);

			liquidities[i] = penalty.liquidityToReturn;
			adjusted0Min[i] = penalty.amount0MinAdjusted;
			adjusted1Min[i] = penalty.amount1MinAdjusted;
		}
	}

	function _removeLiquidityOldPair(
		GovernanceStorage storage $,
		address user,
		uint256 liquidity,
		address token0,
		address token1,
		uint256 amount0Min,
		uint256 amount1Min
	) internal returns (uint amountA, uint amountB) {
		// Approve router
		Pair(Router(payable($.router)).oldPairFor(token0, token1)).approve(
			$.router,
			liquidity
		);

		// Remove liquidity
		return
			Router(payable($.router)).removeLiquidityOld(
				token0,
				token1,
				liquidity,
				amount0Min,
				amount1Min,
				user,
				block.timestamp + 1
			);
	}

	// ******* VIEWS *******

	function getClaimableRewards(
		address user,
		uint256[] calldata nonces
	) external view returns (uint256 totalClaimable) {
		GovernanceStorage storage $ = _getGovernanceStorage();

		// No rewards are being added
		// (, uint256 rpsToAdd) = _addGainzMint(
		// 	Gainz($.gainzToken).stakersGainzToEmit(),
		// 	GToken($.gtoken).totalStakeWeight()
		// );

		(totalClaimable, ) = _calculateClaimableReward(
			user,
			nonces,
			$.gtoken,
			$.rewardPerShare
		);
	}
}
