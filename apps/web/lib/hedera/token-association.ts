import {
	AccountBalanceQuery,
	AccountId,
	TokenAssociateTransaction,
	TokenId,
} from "@hashgraph/sdk";
import {
	addKmsSignatureToFrozenTransaction,
	createKmsHederaSigner,
	executeSignedTransaction,
} from "@workit-poa/hedera-kms-wallet";
import { getAddress } from "ethers";

export interface HtsTokenAssociationSnapshot {
	associated: boolean;
	balance: bigint;
}

export interface AssociationLogger {
	warn: (message: string) => void;
}

export function resolveTokenIdFromAddress(tokenAddress: string): string | null {
	try {
		return TokenId.fromSolidityAddress(getAddress(tokenAddress)).toString();
	} catch {
		return null;
	}
}

export function resolveAddressFromTokenId(tokenId: string): string {
	const solidityHex = TokenId.fromString(tokenId).toSolidityAddress();
	return getAddress(`0x${solidityHex}`);
}

export async function getHtsTokenBalanceSnapshot(params: {
	client: any;
	accountId: string;
	tokenId: TokenId;
}): Promise<HtsTokenAssociationSnapshot> {
	const balance = await new AccountBalanceQuery()
		.setAccountId(params.accountId)
		.execute(params.client);

	const tokenIdStr = params.tokenId.toString();
	let associated = false;
	let balanceTiny = 0n;

	for (const [id, amount] of balance.tokens ?? []) {
		if (id.toString() === tokenIdStr) {
			associated = true;
			balanceTiny = BigInt(amount.toString());
			break;
		}
	}

	return {
		associated,
		balance: balanceTiny,
	};
}

export async function ensureTokenAssociationWithKms(params: {
	hederaClient: any;
	hederaAccountId: string;
	tokenId: TokenId;
	kms: any;
	kmsKeyId: string;
	retries?: number;
	logger?: AssociationLogger;
}): Promise<string | null> {
	const retries = params.retries && params.retries > 0 ? params.retries : 3;

	const snapshot = await getHtsTokenBalanceSnapshot({
		client: params.hederaClient,
		accountId: params.hederaAccountId,
		tokenId: params.tokenId,
	});
	if (snapshot.associated) {
		return null;
	}

	const signer = await createKmsHederaSigner({
		kms: params.kms,
		keyId: params.kmsKeyId,
	});

	let lastError: unknown;
	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			let tx = new TokenAssociateTransaction()
				.setAccountId(AccountId.fromString(params.hederaAccountId))
				.setTokenIds([params.tokenId]);
			tx = await tx.freezeWith(params.hederaClient);

			await addKmsSignatureToFrozenTransaction(tx, signer);
			const { response, receipt } = await executeSignedTransaction(
				params.hederaClient,
				tx,
			);
			const status = receipt.status.toString();
			if (
				status !== "SUCCESS" &&
				status !== "TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT"
			) {
				throw new Error(
					`token association failed with status=${status} tokenId=${params.tokenId.toString()} accountId=${params.hederaAccountId}`,
				);
			}

			return response.transactionId.toString();
		} catch (error) {
			lastError = error;
			if (attempt === retries) break;
			params.logger?.warn(
				`Token association retry ${attempt}/${retries - 1} for token ${params.tokenId.toString()}`,
			);
			await new Promise(resolve => setTimeout(resolve, 300 * attempt));
		}
	}

	throw lastError;
}
