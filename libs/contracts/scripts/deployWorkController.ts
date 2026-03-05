import { ethers, network } from "hardhat";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const TOKEN_CREATE_HBAR_TO_SEND = "15";
const TOKEN_CREATE_GAS_LIMIT = 1_000_000n;

async function main() {
	const [deployer] = await ethers.getSigners();
	const chain = await ethers.provider.getNetwork();

	console.log(`Network: ${network.name} (${chain.chainId.toString()})`);
	console.log(`Deployer (EVM): ${deployer.address}`);

	console.log("Step 1/5 - Deploy WorkEmissionController implementation");
	const controllerFactory = await ethers.getContractFactory(
		"WorkEmissionController",
	);
	const implementation = await controllerFactory.deploy();
	await implementation.waitForDeployment();
	const implementationAddress = await implementation.getAddress();
	console.log(`Implementation deployed: ${implementationAddress}`);

	console.log("Step 2/5 - Deploy ERC1967Proxy and initialize controller");
	const proxyFactory = await ethers.getContractFactory(
		"@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
	);
	const initData = controllerFactory.interface.encodeFunctionData(
		"initialize",
		[deployer.address],
	);
	const proxy = await proxyFactory.deploy(implementationAddress, initData);
	await proxy.waitForDeployment();
	const controllerAddress = await proxy.getAddress();
	console.log(`Controller proxy deployed: ${controllerAddress}`);

	const controller = controllerFactory.attach(controllerAddress);

	console.log(
		"Step 3/5 - Create WRK HTS token via controller (treasury + supplyKey = proxy)",
	);
	console.log(`Using gas limit: ${TOKEN_CREATE_GAS_LIMIT.toString()}`);
	console.log(`Sending ${TOKEN_CREATE_HBAR_TO_SEND} HBAR for token creation...`);
	const createTokenTx = await controller.createWorkToken({
		gasLimit: TOKEN_CREATE_GAS_LIMIT,
		value: ethers.parseEther(TOKEN_CREATE_HBAR_TO_SEND),
	});
	await createTokenTx.wait();

	const wrkTokenAddress = await controller.wrkToken();
	console.log(`WRK token EVM address: ${wrkTokenAddress}`);

	console.log("Step 4/5 - Controller initialized during token creation");

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
	console.log(`workControllerImplementation=${implementationAddress}`);
	console.log(`wrkTokenAddress=${wrkTokenAddress}`);
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
