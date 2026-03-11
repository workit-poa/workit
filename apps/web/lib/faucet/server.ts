import {
  getManagedWalletSignerContext,
  getUsdcFaucetEligibility,
  reserveUsdcFaucetClaim,
  revertUsdcFaucetClaimReservation,
  type UsdcFaucetEligibility
} from "@workit-poa/auth";
import { createHederaJsonRpcProvider, createKmsClientFromEnv, createKmsEvmSigner, parseHederaEvmNetwork } from "@workit-poa/hedera-kms-wallet";
import { Wallet, type JsonRpcProvider } from "ethers";
import { resolveSaucerV2FaucetConfig, swapHbarToUsdcViaSaucerV2 } from "./saucer-v2";

export interface UsdcFaucetClaimedResult {
  status: "claimed";
  tokenSymbol: string;
  amount: string;
  recipient: string;
  transactionHash: string;
  explorerUrl: string | null;
  nextEligibleAt: Date;
}

export interface UsdcFaucetRateLimitedResult {
  status: "rate_limited";
  retryAfterSeconds: number;
  nextEligibleAt: Date;
}

export type UsdcFaucetClaimResult = UsdcFaucetClaimedResult | UsdcFaucetRateLimitedResult;

interface ManagedRecipientWallet {
  recipientAddress: string;
  recipientAccountId: string;
  recipientKmsKeyId: string;
}

type PerformOperatorSwapToUserResult =
  | {
      status: "claimed";
      amount: string;
      recipient: string;
      transactionHash: string;
      tokenSymbol: string;
      nextEligibleAt: Date;
    }
  | {
      status: "rate_limited";
      retryAfterSeconds: number;
      nextEligibleAt: Date;
    };

export interface ClaimDailyUsdcFaucetDeps {
  getFaucetStatus: (userId: string) => Promise<UsdcFaucetEligibility>;
  performSwapToUser: (userId: string) => Promise<PerformOperatorSwapToUserResult>;
}

function resolveProvider(): JsonRpcProvider {
  const network = parseHederaEvmNetwork(process.env.HEDERA_NETWORK);
  const rpcUrl = process.env.HEDERA_EVM_RPC_URL?.trim();
  return createHederaJsonRpcProvider({
    network,
    rpcUrl: rpcUrl && rpcUrl.length > 0 ? rpcUrl : undefined
  });
}

function resolveFaucetOperatorKey(): string {
  const raw =
    process.env.FAUCET_OPERATOR_EVM_PRIVATE_KEY?.trim() ||
    process.env.PAYMASTER_OPERATOR_KEY?.trim() ||
    process.env.OPERATOR_KEY?.trim() ||
    process.env.HEDERA_OPERATOR_KEY?.trim();

  if (!raw) {
    throw new Error(
      "Missing faucet operator key. Set FAUCET_OPERATOR_EVM_PRIVATE_KEY (or PAYMASTER_OPERATOR_KEY/OPERATOR_KEY)."
    );
  }

  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Faucet operator key must be a 32-byte secp256k1 hex private key");
  }

  return normalized;
}

function resolveFaucetDailyAmount(): string {
  const value = process.env.FAUCET_DAILY_USDC_AMOUNT?.trim() || "1";
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error("FAUCET_DAILY_USDC_AMOUNT must be a positive number");
  }
  return value;
}

function resolveFaucetIntervalHours(): number {
  const value = process.env.FAUCET_INTERVAL_HOURS?.trim() || "24";
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error("FAUCET_INTERVAL_HOURS must be a positive integer");
  }
  return numeric;
}

function buildHashscanTxLink(transactionHash: string): string | null {
  const network = (process.env.HEDERA_NETWORK || "testnet").trim().toLowerCase();
  if (network !== "testnet" && network !== "mainnet" && network !== "previewnet") {
    return null;
  }
  return `https://hashscan.io/${network}/tx/${transactionHash}`;
}

async function resolveUserManagedRecipientWallet(userId: string, provider: JsonRpcProvider): Promise<ManagedRecipientWallet> {
  const signerContext = await getManagedWalletSignerContext(userId);
  const kms = createKmsClientFromEnv();
  try {
    const signer = await createKmsEvmSigner({
      kms,
      keyId: signerContext.kmsKeyId,
      provider
    });
    const recipientAddress = await signer.getAddress();
    return {
      recipientAddress,
      recipientAccountId: signerContext.hederaAccountId,
      recipientKmsKeyId: signerContext.kmsKeyId
    };
  } finally {
    kms.destroy();
  }
}

async function performOperatorSwapToUser(userId: string): Promise<PerformOperatorSwapToUserResult> {
  const intervalHours = resolveFaucetIntervalHours();
  const reservation = await reserveUsdcFaucetClaim(userId, intervalHours);
  if (!reservation.ok) {
    return {
      status: "rate_limited",
      retryAfterSeconds: reservation.retryAfterSeconds,
      nextEligibleAt: reservation.nextEligibleAt
    };
  }

  const provider = resolveProvider();

  try {
    const targetUsdcAmount = resolveFaucetDailyAmount();
    const recipient = await resolveUserManagedRecipientWallet(userId, provider);
    const operatorWallet = new Wallet(resolveFaucetOperatorKey(), provider);

    const swap = await swapHbarToUsdcViaSaucerV2({
      provider,
      operatorRunner: operatorWallet,
      recipientAddress: recipient.recipientAddress,
      recipientAccountId: recipient.recipientAccountId,
      recipientKmsKeyId: recipient.recipientKmsKeyId,
      targetUsdcAmount,
      config: resolveSaucerV2FaucetConfig()
    });

    return {
      status: "claimed",
      amount: targetUsdcAmount,
      recipient: recipient.recipientAddress,
      transactionHash: swap.transactionHash,
      tokenSymbol: swap.tokenSymbol,
      nextEligibleAt: reservation.nextEligibleAt
    };
  } catch (error) {
    await revertUsdcFaucetClaimReservation(reservation.reservation).catch(() => undefined);
    throw error;
  }
}

export async function getUsdcFaucetStatus(userId: string): Promise<UsdcFaucetEligibility> {
  return getUsdcFaucetEligibility(userId, resolveFaucetIntervalHours());
}

export async function claimDailyUsdcFaucetWithDeps(userId: string, deps: ClaimDailyUsdcFaucetDeps): Promise<UsdcFaucetClaimResult> {
  const eligibility = await deps.getFaucetStatus(userId);
  if (!eligibility.eligible && eligibility.nextEligibleAt) {
    return {
      status: "rate_limited",
      retryAfterSeconds: eligibility.retryAfterSeconds,
      nextEligibleAt: eligibility.nextEligibleAt
    };
  }

  const swap = await deps.performSwapToUser(userId);
  if (swap.status === "rate_limited") {
    return {
      status: "rate_limited",
      retryAfterSeconds: swap.retryAfterSeconds,
      nextEligibleAt: swap.nextEligibleAt
    };
  }

  return {
    status: "claimed",
    tokenSymbol: swap.tokenSymbol,
    amount: swap.amount,
    recipient: swap.recipient,
    transactionHash: swap.transactionHash,
    explorerUrl: buildHashscanTxLink(swap.transactionHash),
    nextEligibleAt: swap.nextEligibleAt
  };
}

export async function claimDailyUsdcFaucet(userId: string): Promise<UsdcFaucetClaimResult> {
  return claimDailyUsdcFaucetWithDeps(userId, {
    getFaucetStatus: getUsdcFaucetStatus,
    performSwapToUser: performOperatorSwapToUser
  });
}
