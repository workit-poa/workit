import hre, { ethers, network } from "hardhat";
import {
	deploySaucerCoreFactory,
	deploySaucerCoreWhbar,
	deploySaucerRouter02,
	installSaucerPrecompileMocks,
} from "./utils/deploy-contracts";

async function main() {
	const [deployer] = await ethers.getSigners();
	console.log(`network=${network.name}`);
	console.log(`deployer=${deployer.address}`);

	if (network.name === "hardhat") {
		await installSaucerPrecompileMocks(hre);
		console.log("installed local HTS/exchange-rate precompile mocks");
	}

	const factory = await deploySaucerCoreFactory(hre, {
		feeToSetter: deployer.address,
		pairCreateFeeTinycents: 0n,
		tokenCreateFeeTinycents: 0n,
		signer: deployer,
	});
	const whbar = await deploySaucerCoreWhbar(hre, { signer: deployer });
	const router = await deploySaucerRouter02(hre, {
		factory: await factory.getAddress(),
		whbar: await whbar.getAddress(),
		signer: deployer,
	});

	console.log(`factory=${await factory.getAddress()}`);
	console.log(`whbar=${await whbar.getAddress()}`);
	console.log(`router02=${await router.getAddress()}`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`deploy-saucerswap-core failed: ${message}`);
	process.exitCode = 1;
});
