import { artifacts, ethers, network } from "hardhat";
import {
	AccountId,
	Client,
	ContractExecuteTransaction,
	ContractFunctionParameters,
	ContractId,
	Hbar,
	PrivateKey,
} from "@hashgraph/sdk";
import dotenv from "dotenv";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	formatDecodedRevert,
	type RevertDecodingInterface,
} from "./utils/contract-error-decoder";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

type CampaignStatus = 0 | 1 | 2 | 3;
type MirrorNetworkName = "mainnet" | "testnet" | "previewnet";
type HederaNetworkName = "hederaMainnet" | "hederaTestnet" | "hederaPreviewnet" | "hederaLocal";

interface DeploymentFile {
	address: string;
	abi: readonly unknown[];
}

interface CampaignListing {
	campaignToken: string;
	fundingToken: string;
	lockEpochs: bigint;
	goal: bigint;
	deadline: bigint;
}

interface MirrorExchangeRateResponse {
	current_rate?: {
		cent_equivalent?: unknown;
		hbar_equivalent?: unknown;
	};
}

const STATUS_LABEL: Record<CampaignStatus, string> = {
	0: "Pending",
	1: "Funding",
	2: "Failed",
	3: "Success",
};

function toBool(value: string | undefined, fallback = false): boolean {
	if (!value) return fallback;
	const lowered = value.trim().toLowerCase();
	return lowered === "1" || lowered === "true" || lowered === "yes";
}

function resolveConfiguredPairCreateFeeWei(): bigint | null {
	const raw = process.env.LAUNCHPAD_PAIR_CREATE_FEE_HBAR;
	if (!raw || raw.trim().length === 0) return null;
	const value = raw.trim();
	try {
		const parsed = ethers.parseUnits(value, 18);
		if (parsed < 0n) {
			throw new Error("negative");
		}
		return parsed;
	} catch {
		throw new Error(
			`Invalid LAUNCHPAD_PAIR_CREATE_FEE_HBAR value: ${value}`,
		);
	}
}

function parseIntegerLike(value: unknown): bigint | null {
	if (typeof value === "string" && /^-?\d+$/.test(value)) {
		return BigInt(value);
	}
	if (
		typeof value === "number" &&
		Number.isFinite(value) &&
		Number.isInteger(value)
	) {
		return BigInt(value);
	}
	return null;
}

function resolveMirrorBaseUrl(chainId: string): string | null {
	const configured =
		process.env.HEDERA_MIRROR_NODE_URL?.trim() ||
		process.env.HEDERA_MIRROR_REST_URL?.trim();
	if (configured) return configured.replace(/\/+$/, "");

	const mirrorByNetwork: Record<MirrorNetworkName, string> = {
		mainnet: "https://mainnet-public.mirrornode.hedera.com",
		testnet: "https://testnet.mirrornode.hedera.com",
		previewnet: "https://previewnet.mirrornode.hedera.com",
	};
	const byChain: Record<string, MirrorNetworkName> = {
		"295": "mainnet",
		"296": "testnet",
		"297": "previewnet",
	};
	const networkName = byChain[chainId];
	return networkName ? mirrorByNetwork[networkName] : null;
}

function resolveOperatorCredentials(): {
	operatorId: string;
	operatorKey: string;
	source: string;
} {
	const candidates = [
		{
			idName: "PAYMASTER_OPERATOR_ID",
			keyName: "PAYMASTER_OPERATOR_KEY",
		},
		{
			idName: "OPERATOR_ID",
			keyName: "OPERATOR_KEY",
		},
		{
			idName: "HEDERA_OPERATOR_ID",
			keyName: "HEDERA_OPERATOR_KEY",
		},
	] as const;

	for (const candidate of candidates) {
		const id = process.env[candidate.idName]?.trim();
		const key = process.env[candidate.keyName]?.trim();
		if (!id && !key) continue;
		if (!id || !key) {
			throw new Error(
				`Incomplete operator credentials: ${candidate.idName}/${candidate.keyName} must both be set.`,
			);
		}
		return {
			operatorId: id,
			operatorKey: key,
			source: `${candidate.idName}/${candidate.keyName}`,
		};
	}

	throw new Error(
		"Missing operator credentials. Set PAYMASTER_OPERATOR_ID/PAYMASTER_OPERATOR_KEY, OPERATOR_ID/OPERATOR_KEY, or HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY.",
	);
}

function parseOperatorPrivateKey(raw: string): PrivateKey {
	const value = raw.trim();
	const hex = value.startsWith("0x") ? value.slice(2) : value;
	if (/^[0-9a-fA-F]{64}$/.test(hex)) {
		return PrivateKey.fromStringECDSA(hex);
	}

	try {
		return PrivateKey.fromString(value);
	} catch {
		// Fall through.
	}

	throw new Error(
		"Invalid operator private key format. Use Hedera key string or 32-byte ECDSA hex.",
	);
}

function resolveHederaClient(networkName: string): Client {
	const normalized = networkName as HederaNetworkName;
	if (normalized === "hederaMainnet") return Client.forMainnet();
	if (normalized === "hederaPreviewnet") return Client.forPreviewnet();
	if (normalized === "hederaLocal") return Client.forNetwork({
		"127.0.0.1:50211": AccountId.fromString("0.0.3"),
	});
	return Client.forTestnet();
}

function weibarToTinybarRoundUp(weibar: bigint): bigint {
	if (weibar <= 0n) return 0n;
	const weiPerTinybar = 10n ** 10n;
	return (weibar + weiPerTinybar - 1n) / weiPerTinybar;
}

async function fetchMirrorJson<T>(
	chainId: string,
	path: string,
): Promise<T | null> {
	const baseUrl = resolveMirrorBaseUrl(chainId);
	if (!baseUrl) return null;
	try {
		const response = await fetch(`${baseUrl}${path}`, {
			headers: { accept: "application/json" },
		});
		if (!response.ok) return null;
		return (await response.json()) as T;
	} catch {
		return null;
	}
}

async function resolvePairCreateFeeWei(params: {
	chainId: string;
	launchpad: any;
	operator: any;
}): Promise<bigint> {
	try {
		const factoryAddress = ethers.getAddress(await params.launchpad.factory());
		const factory = new ethers.Contract(
			factoryAddress,
			["function pairCreateFee() view returns (uint256)"],
			params.operator,
		);
		const pairCreateFeeTinycent = BigInt(await factory.pairCreateFee());
		if (pairCreateFeeTinycent <= 0n) return 0n;

		const exchangeRates = await fetchMirrorJson<MirrorExchangeRateResponse>(
			params.chainId,
			"/api/v1/network/exchangerate",
		);
		const centEquivalent = parseIntegerLike(
			exchangeRates?.current_rate?.cent_equivalent,
		);
		const hbarEquivalent = parseIntegerLike(
			exchangeRates?.current_rate?.hbar_equivalent,
		);
		if (
			centEquivalent === null ||
			hbarEquivalent === null ||
			centEquivalent <= 0n ||
			hbarEquivalent <= 0n
		) {
			throw new Error(
				"Mirror exchange rates are unavailable for pair fee conversion",
			);
		}

		const tinybarFee =
			(pairCreateFeeTinycent * hbarEquivalent + centEquivalent - 1n) /
			centEquivalent;
		return tinybarFee * 10n ** 10n;
	} catch (error) {
		const configured = resolveConfiguredPairCreateFeeWei();
		if (configured !== null) return configured;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to resolve pair creation fee dynamically: ${message}. Set LAUNCHPAD_PAIR_CREATE_FEE_HBAR as fallback.`,
		);
	}
}

async function resolveDeploymentFilePath(
	chainId: string,
	contractName: string,
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
			// Try the next path.
		}
	}

	throw new Error(
		`Missing deployment file for ${contractName} on chain ${chainId}. Tried: ${candidates.join(", ")}`,
	);
}

async function readDeploymentFile(
	chainId: string,
	contractName: string,
): Promise<DeploymentFile> {
	const path = await resolveDeploymentFilePath(chainId, contractName);
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

async function main() {
	const [operator] = await ethers.getSigners();
	const { operatorId, operatorKey, source } = resolveOperatorCredentials();
	const hederaClient = resolveHederaClient(network.name);
	hederaClient.setOperator(
		AccountId.fromString(operatorId),
		parseOperatorPrivateKey(operatorKey),
	);
	const chain = await ethers.provider.getNetwork();
	const chainId = chain.chainId.toString();
	const dryRun = toBool(process.env.DRY_RUN, false);
	const singleCampaign = process.env.CAMPAIGN_ADDRESS?.trim()
		? ethers.getAddress(process.env.CAMPAIGN_ADDRESS.trim())
		: null;

	console.log(`Network: ${network.name} (${chainId})`);
	console.log(`Operator: ${operator.address}`);
	console.log(`SDK credentials: ${source} (${operatorId})`);
	console.log(`Mode: ${dryRun ? "DRY_RUN" : "EXECUTE"}`);

	const launchpadDeployment = await readDeploymentFile(chainId, "Launchpad");
	const launchpad = new ethers.Contract(
		launchpadDeployment.address,
		launchpadDeployment.abi,
		operator,
	);
	const campaignArtifact = await artifacts.readArtifact("Campaign");
	const campaignDecodeInterface = new ethers.Interface(
		campaignArtifact.abi as any,
	);
	const launchpadDecodeInterface = new ethers.Interface(
		launchpadDeployment.abi as any,
	);
	const decodeInterfaces: RevertDecodingInterface[] = [
		campaignDecodeInterface,
		launchpadDecodeInterface,
	];
	const pairCreateFeeWei = await resolvePairCreateFeeWei({
		chainId,
		launchpad,
		operator,
	});
	const campaignDeployment = await readDeploymentFile(chainId, "Campaign");

	const campaignAddresses = (await launchpad.campaigns()) as string[];
	const targets = singleCampaign
		? campaignAddresses
				.map(address => ethers.getAddress(address))
				.filter(address => address === singleCampaign)
		: campaignAddresses.map(address => ethers.getAddress(address));

	if (targets.length === 0) {
		console.log(
			singleCampaign
				? `No campaign matched CAMPAIGN_ADDRESS=${singleCampaign}`
				: "No campaigns found.",
		);
		return;
	}

	console.log(`Found ${targets.length} campaign(s) to inspect.`);
	let resolvedCount = 0;
	let skippedCount = 0;
	let failedCount = 0;

	for (const campaignAddress of targets) {
		const campaign = new ethers.Contract(
			campaignAddress,
			campaignDeployment.abi,
			operator,
		);

		try {
			const [statusRaw, listingRaw, ownerRaw] = await Promise.all([
				campaign.status(),
				campaign.listing(),
				campaign.owner(),
			]);
			const status = Number(statusRaw) as CampaignStatus;
			const listing = listingRaw as CampaignListing;
			const owner = ethers.getAddress(ownerRaw);
			const now = BigInt(Math.floor(Date.now() / 1000));
			const isExpired = now >= BigInt(listing.deadline);

			console.log(
				`- ${campaignAddress} status=${STATUS_LABEL[status] ?? String(status)} owner=${owner} deadline=${listing.deadline.toString()} expired=${isExpired}`,
			);
			if (dryRun) {
				console.log(
					"  DRY_RUN: associateListingTokens() would be called before resolve checks.",
				);
			} else {
				const associateTx = await campaign.associateListingTokens();
				await associateTx.wait();
				console.log("  listing token association refreshed");
			}

			let shouldResolve = false;
			let resolveTo = ethers.ZeroAddress;
			let resolveValue = 0n;

			if (status === 0) {
				shouldResolve = true;
				resolveTo = ethers.ZeroAddress;
			} else if (status === 1 && isExpired) {
				shouldResolve = true;
				resolveTo = owner;
				const fundingSupply = BigInt(await campaign.fundingSupply());
				console.log(
					`  fundingSupply=${fundingSupply.toString()} goal=${BigInt(listing.goal).toString()}`,
				);
				if (fundingSupply >= BigInt(listing.goal)) {
					resolveValue = pairCreateFeeWei;
				}
			}

			if (!shouldResolve) {
				skippedCount += 1;
				continue;
			}

			if (dryRun) {
				console.log(
					`  DRY_RUN: resolveCampaign(${resolveTo}) with value=${resolveValue.toString()} would be called.`,
				);
				resolvedCount += 1;
				continue;
			}

			const resolveData = campaign.interface.encodeFunctionData(
				"resolveCampaign",
				[resolveTo],
			);
			const resolveValueTinybar = weibarToTinybarRoundUp(resolveValue);
			console.log(
				`  resolveValue: wei=${resolveValue.toString()} tinybar=${resolveValueTinybar.toString()}`,
			);
			await ethers.provider
				.call({
					from: operator.address,
					to: campaignAddress,
					data: resolveData,
					value: resolveValue,
				})
				.catch(error => {
					throw formatDecodedRevert(
						`resolveCampaign preflight for ${campaignAddress}`,
						error,
						decodeInterfaces,
					);
				});

			const params = new ContractFunctionParameters().addAddress(resolveTo);
			let tx = new ContractExecuteTransaction()
				.setContractId(ContractId.fromSolidityAddress(campaignAddress))
				.setGas(1_500_000)
				.setFunction("resolveCampaign", params);
			if (resolveValue > 0n) {
				tx = tx.setPayableAmount(
					Hbar.fromTinybars(
						weibarToTinybarRoundUp(resolveValue).toString(),
					),
				);
			}

			const response = await tx.execute(hederaClient);
			const receipt = await response.getReceipt(hederaClient);
			const rstatus = receipt.status.toString();
			if (rstatus !== "SUCCESS") {
				const record = await response.getRecord(hederaClient).catch(() => null);
				const reason = record?.contractFunctionResult?.errorMessage?.trim();
				throw new Error(
					reason && reason.length > 0
						? `${rstatus}: ${reason}`
						: rstatus,
				);
			}

			console.log(
				`  resolved tx=${response.transactionId.toString()} rstatus=${rstatus}`,
			);
			resolvedCount += 1;
		} catch (error) {
			failedCount += 1;
			if (
				error instanceof Error &&
				error.message.includes("resolveCampaign preflight")
			) {
				console.error(`  FAILED: ${error.message}`);
				continue;
			}
			const decoded = formatDecodedRevert(
				`resolve campaign ${campaignAddress}`,
				error,
				decodeInterfaces,
			);
			console.error(`  FAILED: ${decoded.message}`);
		}
	}

	console.log(
		`Done. resolved=${resolvedCount} skipped=${skippedCount} failed=${failedCount}`,
	);
	hederaClient.close();
}

main().catch(error => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`resolve-campaigns failed: ${message}`);
	process.exitCode = 1;
});
