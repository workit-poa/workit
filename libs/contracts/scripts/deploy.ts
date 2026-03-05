import { ethers, network, upgrades } from "hardhat";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

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
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid number for ${name}: ${value}`);
	}

	return parsed;
}

const WORK_TOKEN_CREATE_HBAR_TO_SEND = envString(
	"WORK_TOKEN_CREATE_HBAR_TO_SEND",
	"15",
);
const GOVERNANCE_NFT_CREATE_HBAR_TO_SEND = envString(
	"GOVERNANCE_NFT_CREATE_HBAR_TO_SEND",
	"15",
);
const TOKEN_CREATE_GAS_LIMIT = envBigInt("DEPLOY_GAS_LIMIT", 1_000_000n);
const GOVERNANCE_NFT_MAX_SUPPLY = envBigInt("GOVERNANCE_NFT_MAX_SUPPLY", 1_000_000n);
const GTOKEN_EPOCH_LENGTH_SECONDS = envNumber(
	"GTOKEN_EPOCH_LENGTH_SECONDS",
	24 * 60 * 60,
);
const CREATE_GOVERNANCE_NFT =
	envString("CREATE_GOVERNANCE_NFT", "true").toLowerCase() !== "false";

async function main() {
	const [deployer] = await ethers.getSigners();
	const chain = await ethers.provider.getNetwork();

	console.log(`Network: ${network.name} (${chain.chainId.toString()})`);
	console.log(`Deployer (EVM): ${deployer.address}`);

	console.log("Step 1/7 - Deploy WorkEmissionController UUPS proxy + implementation");
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
		"Step 2/7 - Create WRK HTS token via WorkEmissionController (treasury + supplyKey = proxy)",
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

	console.log("Step 3/7 - Deploy GToken UUPS proxy + implementation");
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

	let governanceNftTokenAddress = ethers.ZeroAddress;
	if (CREATE_GOVERNANCE_NFT) {
		console.log("Step 4/7 - Create WorkIt governance HTS NFT token via GToken");
		console.log(
			`Sending ${GOVERNANCE_NFT_CREATE_HBAR_TO_SEND} HBAR for governance NFT token creation...`,
		);
		const createGovernanceNftTx = await gToken.createGovernanceNft(
			GOVERNANCE_NFT_MAX_SUPPLY,
			{
				gasLimit: TOKEN_CREATE_GAS_LIMIT,
				value: ethers.parseEther(GOVERNANCE_NFT_CREATE_HBAR_TO_SEND),
			},
		);
		await createGovernanceNftTx.wait();
		governanceNftTokenAddress = await gToken.governanceNftToken();
		console.log(
			`Governance HTS NFT token EVM address: ${governanceNftTokenAddress}`,
		);
	} else {
		console.log("Step 4/7 - Skipped governance NFT token creation");
	}

	console.log("Step 5/7 - Deploy or resolve Rewards contract");
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

	console.log("Step 6/7 - Grant GToken UPDATE_ROLE to Rewards");
	const updateRole = await gToken.UPDATE_ROLE();
	const hasUpdateRole = await gToken.hasRole(updateRole, rewardsAddress);
	if (!hasUpdateRole) {
		const grantUpdateRoleTx = await gToken.grantRole(updateRole, rewardsAddress);
		await grantUpdateRoleTx.wait();
		console.log(`Granted UPDATE_ROLE to Rewards: ${rewardsAddress}`);
	} else {
		console.log("Rewards already has UPDATE_ROLE");
	}

	console.log("Step 7/7 - Configure staking rewards collector");
	const stakingRaw = process.env.WORK_STAKING_ADDRESS?.trim();
	const stakingAddress = stakingRaw
		? ethers.getAddress(stakingRaw)
		: rewardsAddress;

	const stakingTx = await controller.setStakingRewardsCollector(stakingAddress);
	await stakingTx.wait();
	console.log(`Staking rewards collector set: ${stakingAddress}`);

	console.log("Deployment complete.");
	console.log(`workControllerProxy=${controllerAddress}`);
	console.log(`workControllerImplementation=${controllerImplementationAddress}`);
	console.log(`wrkTokenAddress=${wrkTokenAddress}`);
	console.log(`gTokenProxy=${gTokenAddress}`);
	console.log(`gTokenImplementation=${gTokenImplementationAddress}`);
	console.log(`governanceNftTokenAddress=${governanceNftTokenAddress}`);
	console.log(`rewardsAddress=${rewardsAddress}`);
	console.log(`stakingCollector=${stakingAddress}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
