import { ethers, network, upgrades } from "hardhat";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const WORK_TOKEN_CREATE_HBAR_TO_SEND = "15";
const GOVERNANCE_NFT_CREATE_HBAR_TO_SEND = "15";
const TOKEN_CREATE_GAS_LIMIT = 1_000_000n;
const GOVERNANCE_NFT_MAX_SUPPLY = 1_000_000n;
const GTOKEN_EPOCH_LENGTH_SECONDS = 24 * 60 * 60;

async function main() {
	const [deployer] = await ethers.getSigners();
	const chain = await ethers.provider.getNetwork();

	console.log(`Network: ${network.name} (${chain.chainId.toString()})`);
	console.log(`Deployer (EVM): ${deployer.address}`);

	console.log(
		"Step 1/5 - Deploy WorkEmissionController UUPS proxy + implementation",
	);
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
		"Step 2/5 - Create WRK HTS token via WorkEmissionController (treasury + supplyKey = proxy)",
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

	console.log("Step 3/5 - Deploy GToken UUPS proxy + implementation");
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

	console.log("Step 4/5 - Create WorkIt governance HTS NFT token via GToken");
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
	const governanceNftTokenAddress = await gToken.governanceNftToken();
	console.log(
		`Governance HTS NFT token EVM address: ${governanceNftTokenAddress}`,
	);

	const stakingRaw = process.env.WORK_STAKING_ADDRESS?.trim();
	if (stakingRaw) {
		console.log("Step 5/5 - Set staking rewards contract");
		const stakingAddress = ethers.getAddress(stakingRaw);
		const stakingTx =
			await controller.setStakingRewardsCollector(stakingAddress);
		await stakingTx.wait();
		console.log(`Staking rewards collector set: ${stakingAddress}`);
	} else {
		console.log(
			"Step 5/5 - Skipped staking setup (set WORK_STAKING_ADDRESS to configure).",
		);
	}

	console.log("Deployment complete.");
	console.log(`workControllerProxy=${controllerAddress}`);
	console.log(`workControllerImplementation=${controllerImplementationAddress}`);
	console.log(`wrkTokenAddress=${wrkTokenAddress}`);
	console.log(`gTokenProxy=${gTokenAddress}`);
	console.log(`gTokenImplementation=${gTokenImplementationAddress}`);
	console.log(`governanceNftTokenAddress=${governanceNftTokenAddress}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
