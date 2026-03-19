import { artifacts, ethers } from "hardhat";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	formatDecodedRevert,
	type RevertDecodingInterface,
} from "../../scripts/utils/contract-error-decoder";

export interface DeploymentFile {
	address: string;
	abi: readonly unknown[];
}

const DEFAULT_DECODE_CONTRACT_IDS = [
	"Campaign",
	"Launchpad",
	"Staking",
	"Rewards",
	"WORK",
	"vendor/saucerswap-core/contracts/UniswapV2Factory.sol:UniswapV2Factory",
	"vendor/saucerswap-core/contracts/UniswapV2Pair.sol:UniswapV2Pair",
	"vendor/saucerswap-core/contracts/WHBAR.sol:WHBAR",
	"vendor/saucerswap-periphery/contracts/UniswapV2Router02.sol:UniswapV2Router02",
];

export async function loadDecodeInterfaces(
	contractIds: readonly string[] = DEFAULT_DECODE_CONTRACT_IDS,
): Promise<RevertDecodingInterface[]> {
	const interfaces: RevertDecodingInterface[] = [];

	for (const contractId of contractIds) {
		try {
			const artifact = await artifacts.readArtifact(contractId);
			interfaces.push(new ethers.Interface(artifact.abi as any));
		} catch {
			// Keep decoding best-effort.
		}
	}

	return interfaces;
}

const HEDERA_GAS_BUFFER_BPS = 2_000n; // +20%
const HEDERA_GAS_BUFFER_BASE = 21_000n;

function withGasBuffer(gasEstimate: bigint): bigint {
	return (
		gasEstimate +
		(gasEstimate * HEDERA_GAS_BUFFER_BPS) / 10_000n +
		HEDERA_GAS_BUFFER_BASE
	);
}

export async function runTx(
	action: string,
	send: (txOverrides?: { gasLimit?: bigint }) => Promise<any>,
	decodeInterfaces: RevertDecodingInterface[],
	estimateGas?: () => Promise<bigint>,
) {
	try {
		const tx = await send(
			estimateGas
				? {
						gasLimit: withGasBuffer(await estimateGas()),
				  }
				: undefined,
		);
		await tx.wait();
	} catch (error) {
		throw formatDecodedRevert(action, error, decodeInterfaces);
	}
}

export async function resolveDeploymentFilePath(
	contractName: string,
	chainId = "296",
): Promise<string> {
	const candidates = [
		resolve(process.cwd(), "deployments", chainId, `${contractName}.json`),
		resolve(
			process.cwd(),
			"libs/contracts/deployments",
			chainId,
			`${contractName}.json`,
		),
	];

	for (const candidate of candidates) {
		try {
			await access(candidate);
			return candidate;
		} catch {
			// continue
		}
	}
	throw new Error(
		`Missing deployment file for ${contractName}. Tried: ${candidates.join(", ")}`,
	);
}

export async function readDeployment(
	contractName: string,
	chainId = "296",
): Promise<DeploymentFile> {
	const path = await resolveDeploymentFilePath(contractName, chainId);
	const raw = await readFile(path, "utf8");
	const parsed = JSON.parse(raw) as { address?: unknown; abi?: unknown };
	if (typeof parsed.address !== "string" || !Array.isArray(parsed.abi)) {
		throw new Error(`Invalid deployment file: ${path}`);
	}
	return {
		address: ethers.getAddress(parsed.address),
		abi: parsed.abi as readonly unknown[],
	};
}

export async function resolveWorkDeployment(): Promise<DeploymentFile> {
	try {
		return await readDeployment("WORK");
	} catch {
		return readDeployment("WorkEmissionController");
	}
}
