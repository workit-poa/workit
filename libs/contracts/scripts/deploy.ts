import { ethers, network, upgrades } from "hardhat";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const WRK_ICO_FUNDS = 734_999_999_775_143n;

function envString(name: string, fallback: string): string {
	const value = process.env[name]?.trim();
	return value && value.length > 0 ? value : fallback;
}

function envBigInt(name: string, fallback: bigint): bigint {
	const value = process.env[name]?.trim();
	if (!value) return fallback;

	try {
		return BigInt(value);
	} catch {
		throw new Error(`Invalid bigint for ${name}: ${value}`);
	}
}

function envNumber(name: string, fallback: number): number {
	const value = process.env[name]?.trim();
	if (!value) return fallback;

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
		throw new Error(`Invalid number for ${name}: ${value}`);
	}

	return parsed;
}

function envAddressList(name: string): string[] {
	const value = process.env[name]?.trim();
	if (!value) return [];

	const unique = new Set<string>();
	for (const raw of value.split(",")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;
		unique.add(ethers.getAddress(trimmed));
	}

	return Array.from(unique);
}

const WORK_TOKEN_CREATE_HBAR_TO_SEND = envString(
	"WORK_TOKEN_CREATE_HBAR_TO_SEND",
	"15",
);
const POSITION_NFT_CREATE_HBAR_TO_SEND = envString(
	"POSITION_NFT_CREATE_HBAR_TO_SEND",
	envString("GOVERNANCE_NFT_CREATE_HBAR_TO_SEND", "15"),
);
const TOKEN_CREATE_GAS_LIMIT = envBigInt("DEPLOY_GAS_LIMIT", 1_000_000n);
const POSITION_NFT_MAX_SUPPLY = envBigInt(
	"POSITION_NFT_MAX_SUPPLY",
	envBigInt("GOVERNANCE_NFT_MAX_SUPPLY", 1_000_000n),
);
const POSITION_NFT_NAME = envString(
	"POSITION_NFT_NAME",
	"WorkIt Position NFT",
);
const POSITION_NFT_SYMBOL = envString("POSITION_NFT_SYMBOL", "WGTPOS");
const POSITION_NFT_MEMO = envString(
	"POSITION_NFT_MEMO",
	"workit-position-nft",
);
const GTOKEN_EPOCH_LENGTH_SECONDS = envNumber(
	"GTOKEN_EPOCH_LENGTH_SECONDS",
	24 * 60 * 60,
);
const CREATE_POSITION_NFT =
	envString(
		"CREATE_POSITION_NFT",
		envString("CREATE_GOVERNANCE_NFT", "true"),
	).toLowerCase() !== "false";
const POSITION_NFT_ASSOCIATE_ACCOUNTS = envAddressList(
	"POSITION_NFT_ASSOCIATE_ACCOUNTS",
);

// SaucerSwap V1 router on Hedera testnet: 0.0.19264
const SAUCERSWAP_V2_ROUTER_ADDRESS = ethers.getAddress(
	"0x0000000000000000000000000000000000004b40",
);
// USDC on Hedera testnet: 0.0.429274
const ICO_FUNDING_TOKEN_ADDRESS = ethers.getAddress(
	"0x0000000000000000000000000000000000068cda",
);
// Zero address means "use freshly deployed WRK token as campaign token".
const ICO_CAMPAIGN_TOKEN_ADDRESS = ethers.ZeroAddress;
// First launchpad campaign skips security GTokens.
const ICO_SECURITY_NONCES: bigint[] = [];
const ICO_CAMPAIGN_SUPPLY = WRK_ICO_FUNDS;
// 1 USDC with 6 decimals.
const ICO_GOAL = 1n * 10n ** 6n;
const ICO_LOCK_EPOCHS = 180n;
const ICO_DEADLINE_DAYS = 2;
const LAUNCHPAD_URI = envString(
	"LAUNCHPAD_URI",
	"ipfs://workit-launchpad/{id}.json",
);

const ERC20_ABI: string[] = [
	"function balanceOf(address account) external view returns (uint256)",
	"function allowance(address owner, address spender) external view returns (uint256)",
	"function approve(address spender, uint256 amount) external returns (bool)",
];

async function main() {
	const [deployer] = await ethers.getSigners();
	const chain = await ethers.provider.getNetwork();

	console.log(`Network: ${network.name} (${chain.chainId.toString()})`);
	console.log(`Deployer (EVM): ${deployer.address}`);

	console.log("Step 1/15 - Deploy WorkEmissionController UUPS proxy + implementation");
	const controllerFactory = await ethers.getContractFactory(
		"WorkEmissionController",
	);
	const controllerProxy = await upgrades.deployProxy(
		controllerFactory,
		[deployer.address],
		{
			initializer: "initialize",
			kind: "uups",
		},
	);
	await controllerProxy.waitForDeployment();
	const controllerAddress = await controllerProxy.getAddress();
	const controllerImplementationAddress =
		await upgrades.erc1967.getImplementationAddress(controllerAddress);

	console.log(
		`Controller implementation deployed: ${controllerImplementationAddress}`,
	);
	console.log(`Controller proxy deployed: ${controllerAddress}`);

	const controller = controllerFactory.attach(controllerAddress) as any;

	console.log(
		"Step 2/15 - Create WRK HTS token via WorkEmissionController (treasury + supplyKey = proxy)",
	);
	console.log(`Using gas limit: ${TOKEN_CREATE_GAS_LIMIT.toString()}`);
	console.log(
		`Sending ${WORK_TOKEN_CREATE_HBAR_TO_SEND} HBAR for WRK token creation...`,
	);
	const createWorkTokenTx = await controller.createWorkToken({
		gasLimit: TOKEN_CREATE_GAS_LIMIT,
		value: ethers.parseEther(WORK_TOKEN_CREATE_HBAR_TO_SEND),
	});
	await createWorkTokenTx.wait();
	const wrkTokenAddress = await controller.wrkToken();
	console.log(`WRK token EVM address: ${wrkTokenAddress}`);

	console.log("Step 3/15 - Deploy GToken UUPS proxy + implementation");
	const gTokenFactory = await ethers.getContractFactory("GToken");
	const gTokenProxy = await upgrades.deployProxy(
		gTokenFactory,
		[deployer.address, GTOKEN_EPOCH_LENGTH_SECONDS],
		{
			initializer: "initialize",
			kind: "uups",
		},
	);
	await gTokenProxy.waitForDeployment();
	const gTokenAddress = await gTokenProxy.getAddress();
	const gTokenImplementationAddress =
		await upgrades.erc1967.getImplementationAddress(gTokenAddress);

	console.log(`GToken implementation deployed: ${gTokenImplementationAddress}`);
	console.log(`GToken proxy deployed: ${gTokenAddress}`);

	const gToken = gTokenFactory.attach(gTokenAddress) as any;

	let positionNftTokenAddress = ethers.ZeroAddress;
	if (CREATE_POSITION_NFT) {
		console.log("Step 4/15 - Create HTS position NFT token via GToken");
		console.log(
			`Sending ${POSITION_NFT_CREATE_HBAR_TO_SEND} HBAR for position NFT token creation...`,
		);
		const createPositionNftTx = await gToken.createPositionNft(
			POSITION_NFT_MAX_SUPPLY,
			POSITION_NFT_NAME,
			POSITION_NFT_SYMBOL,
			POSITION_NFT_MEMO,
			{
				gasLimit: TOKEN_CREATE_GAS_LIMIT,
				value: ethers.parseEther(POSITION_NFT_CREATE_HBAR_TO_SEND),
			},
		);
		await createPositionNftTx.wait();
		positionNftTokenAddress = await gToken.positionNftToken();
		console.log(`Position HTS NFT token EVM address: ${positionNftTokenAddress}`);
	} else {
		console.log("Step 4/15 - Skipped position NFT token creation");
	}

	if (CREATE_POSITION_NFT && POSITION_NFT_ASSOCIATE_ACCOUNTS.length > 0) {
		console.log("Step 5/15 - Associate configured accounts with position NFT token");
		for (const account of POSITION_NFT_ASSOCIATE_ACCOUNTS) {
			const tx = await gToken.associatePositionNft(account, {
				gasLimit: TOKEN_CREATE_GAS_LIMIT,
			});
			await tx.wait();
			console.log(`Associated account: ${account}`);
		}
	} else {
		console.log("Step 5/15 - Skipped position NFT associations");
	}

	console.log("Step 6/15 - Deploy or resolve Rewards contract");
	let rewardsAddress: string;
	const externalRewardsRaw = process.env.WORK_REWARDS_ADDRESS?.trim();
	if (externalRewardsRaw) {
		rewardsAddress = ethers.getAddress(externalRewardsRaw);
		console.log(`Using existing Rewards contract: ${rewardsAddress}`);
	} else {
		const rewardsFactory = await ethers.getContractFactory("Rewards");
		const rewards = await rewardsFactory.deploy();
		await rewards.waitForDeployment();
		rewardsAddress = await rewards.getAddress();
		console.log(`Rewards deployed: ${rewardsAddress}`);

		const initializeRewardsTx = await rewards.initialize(
			wrkTokenAddress,
			gTokenAddress,
			controllerAddress,
		);
		await initializeRewardsTx.wait();
		console.log("Rewards initialized");
	}

	console.log("Step 7/15 - Grant GToken UPDATE_ROLE to Rewards");
	const updateRole = await gToken.UPDATE_ROLE();
	const hasUpdateRole = await gToken.hasRole(updateRole, rewardsAddress);
	if (!hasUpdateRole) {
		const grantUpdateRoleTx = await gToken.grantRole(updateRole, rewardsAddress);
		await grantUpdateRoleTx.wait();
		console.log(`Granted UPDATE_ROLE to Rewards: ${rewardsAddress}`);
	} else {
		console.log("Rewards already has UPDATE_ROLE");
	}

	console.log("Step 8/15 - Configure staking rewards collector");
	const stakingRaw = process.env.WORK_STAKING_ADDRESS?.trim();
	const stakingCollectorAddress = stakingRaw
		? ethers.getAddress(stakingRaw)
		: rewardsAddress;

	const stakingTx = await controller.setStakingRewardsCollector(
		stakingCollectorAddress,
	);
	await stakingTx.wait();
	console.log(`Staking rewards collector set: ${stakingCollectorAddress}`);

	let launchpadStakingAddress = ethers.ZeroAddress;
	let launchpadAddress = ethers.ZeroAddress;
	let campaignBeaconAddress = ethers.ZeroAddress;
	let campaignAddress = ethers.ZeroAddress;
	let launchpadFactoryAddress = ethers.ZeroAddress;

	console.log("Launchpad orchestration enabled: deploying Staking + Campaign beacon + Launchpad");

	const routerAddress = SAUCERSWAP_V2_ROUTER_ADDRESS;
	const fundingTokenAddress = ICO_FUNDING_TOKEN_ADDRESS;
	const campaignTokenAddress =
		ICO_CAMPAIGN_TOKEN_ADDRESS === ethers.ZeroAddress
			? wrkTokenAddress
			: ICO_CAMPAIGN_TOKEN_ADDRESS;

	const router = (await ethers.getContractAt(
		"IUniswapV2Router",
		routerAddress,
	)) as any;

	launchpadFactoryAddress = await router.factory();

	console.log("Step 9/15 - Deploy and initialize Staking");
	const stakingFactory = await ethers.getContractFactory("Staking");
	const stakingContract = await stakingFactory.deploy();
	await stakingContract.waitForDeployment();
	launchpadStakingAddress = await stakingContract.getAddress();

	const initializeStakingTx = await stakingContract.initialize(
		routerAddress,
		rewardsAddress,
		wrkTokenAddress,
		gTokenAddress,
	);
	await initializeStakingTx.wait();
	console.log(`Staking deployed: ${launchpadStakingAddress}`);

	console.log("Step 10/15 - Grant GToken MINTER_ROLE to Staking");
	const minterRole = await gToken.MINTER_ROLE();
	const hasMinterRole = await gToken.hasRole(
		minterRole,
		launchpadStakingAddress,
	);
	if (!hasMinterRole) {
		const grantMinterRoleTx = await gToken.grantRole(
			minterRole,
			launchpadStakingAddress,
		);
		await grantMinterRoleTx.wait();
		console.log(`Granted MINTER_ROLE to Staking: ${launchpadStakingAddress}`);
	} else {
		console.log("Staking already has MINTER_ROLE");
	}

	console.log("Step 11/15 - Deploy Campaign implementation beacon");
	const campaignFactory = await ethers.getContractFactory("Campaign");
	const campaignBeacon = await upgrades.deployBeacon(campaignFactory);
	await campaignBeacon.waitForDeployment();
	campaignBeaconAddress = await campaignBeacon.getAddress();
	console.log(`Campaign beacon deployed: ${campaignBeaconAddress}`);

	console.log("Step 12/15 - Deploy and initialize Launchpad");
	const launchpadFactoryContract = await ethers.getContractFactory("Launchpad");
	const launchpadContract = await launchpadFactoryContract.deploy();
	await launchpadContract.waitForDeployment();
	launchpadAddress = await launchpadContract.getAddress();

	const initializeLaunchpadTx = await launchpadContract.initialize(
		launchpadFactoryAddress,
		gTokenAddress,
		campaignBeaconAddress,
		LAUNCHPAD_URI,
		launchpadStakingAddress,
	);
	await initializeLaunchpadTx.wait();
	console.log(`Launchpad deployed: ${launchpadAddress}`);

	console.log("Step 13/15 - Prepare ICO campaign balances and approvals");
	if (ICO_CAMPAIGN_SUPPLY <= 0n) {
		throw new Error("ICO_CAMPAIGN_SUPPLY must be greater than zero");
	}

	if (ICO_LOCK_EPOCHS <= 0n) {
		throw new Error("ICO_LOCK_EPOCHS must be greater than zero");
	}

	if (ICO_GOAL <= 0n) {
		throw new Error("ICO_GOAL must be a positive value");
	}

	const campaignToken = (await ethers.getContractAt(
		ERC20_ABI,
		campaignTokenAddress,
	)) as any;

	const deployerCampaignBalance = (await campaignToken.balanceOf(
		deployer.address,
	)) as bigint;
	if (deployerCampaignBalance < ICO_CAMPAIGN_SUPPLY) {
		throw new Error(
			`Insufficient campaign token balance. required=${ICO_CAMPAIGN_SUPPLY.toString()} available=${deployerCampaignBalance.toString()}`,
		);
	}

	const allowance = (await campaignToken.allowance(
		deployer.address,
		launchpadAddress,
	)) as bigint;
	if (allowance < ICO_CAMPAIGN_SUPPLY) {
		const approveCampaignTokenTx = await campaignToken.approve(
			launchpadAddress,
			ICO_CAMPAIGN_SUPPLY,
		);
		await approveCampaignTokenTx.wait();
		console.log("Campaign token allowance granted to Launchpad");
	}

	console.log("Step 14/15 - Create WRK/USDC ICO campaign on Launchpad");
	const latestBlock = await ethers.provider.getBlock("latest");
	const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
	const deadline = BigInt(now + ICO_DEADLINE_DAYS * 24 * 60 * 60);

	const createCampaignTx = await launchpadContract.createCampaign(
		{
			campaignToken: campaignTokenAddress,
			fundingToken: fundingTokenAddress,
			lockEpochs: ICO_LOCK_EPOCHS,
			goal: ICO_GOAL,
			deadline,
		},
		ICO_SECURITY_NONCES,
		ICO_CAMPAIGN_SUPPLY,
	);
	await createCampaignTx.wait();

	campaignAddress = await launchpadContract.campaignByTokens(
		fundingTokenAddress,
		campaignTokenAddress,
	);
	console.log(`ICO campaign deployed: ${campaignAddress}`);

	console.log("Step 15/15 - Launchpad orchestration complete");

	console.log("Deployment complete.");
	console.log(`workControllerProxy=${controllerAddress}`);
	console.log(`workControllerImplementation=${controllerImplementationAddress}`);
	console.log(`wrkTokenAddress=${wrkTokenAddress}`);
	console.log(`gTokenProxy=${gTokenAddress}`);
	console.log(`gTokenImplementation=${gTokenImplementationAddress}`);
	console.log(`positionNftTokenAddress=${positionNftTokenAddress}`);
	console.log(`rewardsAddress=${rewardsAddress}`);
	console.log(`stakingCollector=${stakingCollectorAddress}`);
	console.log(`launchpadStakingAddress=${launchpadStakingAddress}`);
	console.log(`launchpadFactoryAddress=${launchpadFactoryAddress}`);
	console.log(`campaignBeaconAddress=${campaignBeaconAddress}`);
	console.log(`launchpadAddress=${launchpadAddress}`);
	console.log(`launchpadWRKAddress=${wrkTokenAddress}`);
	console.log(`campaignAddress=${campaignAddress}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
