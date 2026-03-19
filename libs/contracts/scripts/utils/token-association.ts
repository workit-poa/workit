import { Contract, ethers } from "ethers";

export interface AssociationCounts {
	associatedCount: number;
	alreadyAssociatedCount: number;
	nonHtsCount: number;
	skippedCount: number;
}

const ASSOCIATED_STATUS = 1n;
const ALREADY_ASSOCIATED_STATUS = 2n;
const NON_HTS_STATUS = 0n;

function uniqueTokenAddresses(tokens: string[]): string[] {
	const unique = new Set<string>();
	for (const raw of tokens) {
		const trimmed = raw?.trim();
		if (!trimmed || trimmed === ethers.ZeroAddress) continue;
		unique.add(ethers.getAddress(trimmed));
	}
	return Array.from(unique);
}

async function withRetries<T>(action: () => Promise<T>, maxAttempts = 3): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await action();
		} catch (error) {
			lastError = error;
			if (attempt === maxAttempts) break;
			await new Promise(resolve => setTimeout(resolve, attempt * 500));
		}
	}
	throw lastError;
}

function hasFunction(contract: Contract, signature: string): boolean {
	try {
		return contract.interface.getFunction(signature) !== null;
	} catch {
		return false;
	}
}

export async function ensureContractTokenAssociations(params: {
	label: string;
	contract: Contract;
	tokens: string[];
}): Promise<AssociationCounts> {
	const tokens = uniqueTokenAddresses(params.tokens);
	const counts: AssociationCounts = {
		associatedCount: 0,
		alreadyAssociatedCount: 0,
		nonHtsCount: 0,
		skippedCount: 0,
	};

	if (tokens.length === 0) {
		console.log(`[association] ${params.label}: no tokens to process`);
		return counts;
	}

	const hasBatch = hasFunction(
		params.contract,
		"associateTokensIfNeeded(address[])",
	);
	if (hasBatch) {
		const preview = (await params.contract.associateTokensIfNeeded.staticCall(
			tokens,
		)) as [bigint, bigint, bigint];
		counts.associatedCount = Number(preview[0]);
		counts.alreadyAssociatedCount = Number(preview[1]);
		counts.nonHtsCount = Number(preview[2]);
		counts.skippedCount = counts.alreadyAssociatedCount + counts.nonHtsCount;

		if (counts.associatedCount === 0) {
			console.log(
				`[association] ${params.label}: all ${tokens.length} tokens already associated or non-HTS`,
			);
			return counts;
		}

		const tx = await withRetries(() =>
			params.contract.associateTokensIfNeeded(tokens),
		);
		await tx.wait();
		console.log(
			`[association] ${params.label}: associated=${counts.associatedCount} already=${counts.alreadyAssociatedCount} nonHts=${counts.nonHtsCount}`,
		);
		return counts;
	}

	if (!hasFunction(params.contract, "associateTokenIfNeeded(address)")) {
		throw new Error(
			`Contract ${params.label} does not expose associateTokenIfNeeded/associateTokensIfNeeded`,
		);
	}

	for (const token of tokens) {
		const preview = await params.contract.associateTokenIfNeeded.staticCall(token);
		if (typeof preview === "boolean") {
			if (!preview) {
				counts.skippedCount++;
				continue;
			}
			const tx = await withRetries(() => params.contract.associateTokenIfNeeded(token));
			await tx.wait();
			counts.associatedCount++;
			continue;
		}

		const status = BigInt(preview);
		if (status === ASSOCIATED_STATUS) {
			const tx = await withRetries(() => params.contract.associateTokenIfNeeded(token));
			await tx.wait();
			counts.associatedCount++;
		} else if (status === ALREADY_ASSOCIATED_STATUS) {
			counts.alreadyAssociatedCount++;
			counts.skippedCount++;
		} else if (status === NON_HTS_STATUS) {
			counts.nonHtsCount++;
			counts.skippedCount++;
		} else {
			throw new Error(
				`Unexpected association status ${status.toString()} from ${params.label} for token ${token}`,
			);
		}
	}

	console.log(
		`[association] ${params.label}: associated=${counts.associatedCount} already=${counts.alreadyAssociatedCount} nonHts=${counts.nonHtsCount}`,
	);
	return counts;
}
