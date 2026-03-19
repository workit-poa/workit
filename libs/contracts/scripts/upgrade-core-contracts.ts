import { artifacts, ethers, network } from "hardhat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONTRACTS_TO_UPGRADE = [
	// "WORK",
	// "GToken",
	// "Rewards",
	"Staking",
	"Launchpad",
	"CampaignBeacon",
] as const;

type UupsUpgradeTarget = {
	artifactName: string;
	implementationDeploymentName: string;
	auth: "ownable" | "gTokenAdmin";
};

const UUPS_UPGRADE_TARGETS: Partial<
	Record<(typeof CONTRACTS_TO_UPGRADE)[number], UupsUpgradeTarget>
> = {
	WORK: {
		artifactName: "WORK",
		implementationDeploymentName: "WORKImplementation",
		auth: "ownable",
	},
	GToken: {
		artifactName: "GToken",
		implementationDeploymentName: "GTokenImplementation",
		auth: "gTokenAdmin",
	},
	Rewards: {
		artifactName: "Rewards",
		implementationDeploymentName: "RewardsImplementation",
		auth: "ownable",
	},
	Staking: {
		artifactName: "Staking",
		implementationDeploymentName: "StakingImplementation",
		auth: "ownable",
	},
	Launchpad: {
		artifactName: "Launchpad",
		implementationDeploymentName: "LaunchpadImplementation",
		auth: "ownable",
	},
};
interface DeploymentFile {
	address: string;
	abi: readonly unknown[];
}

async function readDeployment(chainId: string, name: string): Promise<DeploymentFile> {
	const path = resolve(process.cwd(), "deployments", chainId, `${name}.json`);
	const fallback = resolve(
		process.cwd(),
		"libs/contracts/deployments",
		chainId,
		`${name}.json`,
	);

	for (const candidate of [path, fallback]) {
		try {
			const raw = await readFile(candidate, "utf8");
			const parsed = JSON.parse(raw) as { address?: unknown; abi?: unknown };
			if (typeof parsed.address !== "string" || !Array.isArray(parsed.abi)) {
				throw new Error(`Invalid deployment file: ${candidate}`);
			}
			return {
				address: ethers.getAddress(parsed.address),
				abi: parsed.abi as readonly unknown[],
			};
		} catch {
			// try next
		}
	}

	throw new Error(
		`Missing deployment file for ${name}. Looked under deployments/${chainId} and libs/contracts/deployments/${chainId}.`,
	);
}

async function writeDeployment(params: {
	chainId: string;
	name: string;
	artifactName: string;
	address: string;
}) {
	const artifact = await artifacts.readArtifact(params.artifactName);
	const payload = {
		address: ethers.getAddress(params.address),
		abi: artifact.abi as readonly unknown[],
	};

	const targets = [
		resolve(process.cwd(), "deployments", params.chainId),
		resolve(process.cwd(), "libs/contracts/deployments", params.chainId),
	];

	await Promise.all(
		targets.map(async dir => {
			await mkdir(dir, { recursive: true });
			await writeFile(
				resolve(dir, `${params.name}.json`),
				`${JSON.stringify(payload, null, 2)}\n`,
				"utf8",
			);
		}),
	);
}

async function assertOwnableUpgradeAuth(proxyAddress: string, signer: string) {
	const ownable = new ethers.Contract(
		proxyAddress,
		["function owner() view returns (address)"],
		ethers.provider,
	);
	const owner = ethers.getAddress(await ownable.owner());
	if (owner !== signer) {
		throw new Error(
			`Signer is not owner for proxy ${proxyAddress}. owner=${owner} signer=${signer}`,
		);
	}
}

async function assertGTokenUpgradeAuth(proxyAddress: string, signer: string) {
	const gToken = new ethers.Contract(
		proxyAddress,
		[
			"function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
			"function hasRole(bytes32,address) view returns (bool)",
		],
		ethers.provider,
	);
	const adminRole = await gToken.DEFAULT_ADMIN_ROLE();
	const hasRole = await gToken.hasRole(adminRole, signer);
	if (!hasRole) {
		throw new Error(`Signer ${signer} is missing DEFAULT_ADMIN_ROLE on GToken`);
	}
}

async function upgradeUupsProxy(params: {
	chainId: string;
	deploymentName: string;
	artifactName: string;
	implementationDeploymentName: string;
	signer: string;
	auth: "ownable" | "gTokenAdmin";
}) {
	const deployment = await readDeployment(params.chainId, params.deploymentName);

	if (params.auth === "ownable") {
		await assertOwnableUpgradeAuth(deployment.address, params.signer);
	} else {
		await assertGTokenUpgradeAuth(deployment.address, params.signer);
	}

	const implementationFactory = await ethers.getContractFactory(params.artifactName);
	const implementation = await implementationFactory.deploy();
	await implementation.waitForDeployment();
	const implementationAddress = await implementation.getAddress();

	const proxy = new ethers.Contract(
		deployment.address,
		["function upgradeToAndCall(address,bytes) external"],
		await ethers.getSigner(params.signer),
	);
	const upgradeTx = await proxy.upgradeToAndCall(implementationAddress, "0x");
	await upgradeTx.wait();

	await writeDeployment({
		chainId: params.chainId,
		name: params.implementationDeploymentName,
		artifactName: params.artifactName,
		address: implementationAddress,
	});

	console.log(
		`${params.deploymentName} upgraded. newImplementation=${implementationAddress}`,
	);
}

async function main() {
	const [deployer] = await ethers.getSigners();
	const chain = await ethers.provider.getNetwork();
	const chainId = chain.chainId.toString();

	console.log(`Network: ${network.name} (${chainId})`);
	console.log(`Upgrader: ${deployer.address}`);

	for (const contractName of CONTRACTS_TO_UPGRADE) {
		const upgradeTarget = UUPS_UPGRADE_TARGETS[contractName];
		if (upgradeTarget) {
			await upgradeUupsProxy({
				chainId,
				deploymentName: contractName,
				artifactName: upgradeTarget.artifactName,
				implementationDeploymentName: upgradeTarget.implementationDeploymentName,
				signer: deployer.address,
				auth: upgradeTarget.auth,
			});
			continue;
		}

		if (contractName === "CampaignBeacon") {
			const beaconDeployment = await readDeployment(chainId, "CampaignBeacon");
			const beacon = new ethers.Contract(
				beaconDeployment.address,
				[
					"function owner() view returns (address)",
					"function implementation() view returns (address)",
					"function upgradeTo(address) external",
				],
				deployer,
			);
			const beaconOwner = ethers.getAddress(await beacon.owner());
			if (beaconOwner !== deployer.address) {
				throw new Error(
					`Signer is not CampaignBeacon owner. owner=${beaconOwner} signer=${deployer.address}`,
				);
			}

			const campaignFactory = await ethers.getContractFactory("Campaign");
			const newCampaignImplementation = await campaignFactory.deploy();
			await newCampaignImplementation.waitForDeployment();
			const campaignImplementationAddress = await newCampaignImplementation.getAddress();

			const beaconUpgradeTx = await beacon.upgradeTo(campaignImplementationAddress);
			await beaconUpgradeTx.wait();

			await writeDeployment({
				chainId,
				name: "CampaignImplementation",
				artifactName: "Campaign",
				address: campaignImplementationAddress,
			});

			console.log(
				`Campaign beacon upgraded. newImplementation=${campaignImplementationAddress}`,
			);
			continue;
		}

		throw new Error(`Unsupported contract upgrade target: ${contractName}`);
	}
	console.log("Core protocol upgrades complete.");
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
