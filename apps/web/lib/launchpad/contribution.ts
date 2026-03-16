import type {
  CampaignContributionPreview,
  SponsoredTxResult,
} from "./types";

export const HBAR_DECIMALS = 8;

export interface ContributionConfig {
  campaignAddress: string;
  fundingToken: string;
  amountInput: string;
  amountRaw: bigint;
  fundingTokenDecimals: number;
  recipient: string;
  nativeHbarReserveRaw: bigint;
  isWhbarFundingToken: boolean;
}

export interface ContributionReads {
  readWhbarBalance: () => Promise<bigint>;
  readNativeHbarBalance: () => Promise<bigint>;
  readAllowance: () => Promise<bigint>;
}

export interface ContributionWrites {
  associateFundingToken?: () => Promise<SponsoredTxResult | null>;
  wrapHbar: (amount: bigint) => Promise<SponsoredTxResult>;
  approveFundingToken: (amount: bigint) => Promise<SponsoredTxResult>;
  contribute: (amount: bigint, recipient: string) => Promise<SponsoredTxResult>;
}

export interface ContributionRuntime {
  reads: ContributionReads;
  writes: ContributionWrites;
  refetchAfterSuccess?: () => Promise<void>;
}

export function computeWrapShortfall(params: {
  requiredAmount: bigint;
  whbarBalance: bigint;
}): bigint {
  if (params.requiredAmount <= 0n) return 0n;
  return params.whbarBalance >= params.requiredAmount
    ? 0n
    : params.requiredAmount - params.whbarBalance;
}

export function isApprovalNeeded(params: {
  allowance: bigint;
  requiredAmount: bigint;
}): boolean {
  return params.allowance < params.requiredAmount;
}

export function isZeroOrNegativeAmount(amount: bigint): boolean {
  return amount <= 0n;
}

export function buildContributionPreview(params: {
  config: ContributionConfig;
  whbarBalance: bigint;
  nativeHbarBalance: bigint;
  allowance: bigint;
}): CampaignContributionPreview {
  const wrapAmount = params.config.isWhbarFundingToken
    ? computeWrapShortfall({
        requiredAmount: params.config.amountRaw,
        whbarBalance: params.whbarBalance,
      })
    : 0n;

  return {
    campaignAddress: params.config.campaignAddress,
    fundingToken: params.config.fundingToken,
    amount: params.config.amountInput,
    amountRaw: params.config.amountRaw.toString(),
    fundingTokenDecimals: params.config.fundingTokenDecimals,
    usesWhbarFunding: params.config.isWhbarFundingToken,
    whbarBalanceRaw: params.whbarBalance.toString(),
    nativeHbarBalanceRaw: params.nativeHbarBalance.toString(),
    nativeHbarReserveRaw: params.config.nativeHbarReserveRaw.toString(),
    wrapAmountRaw: wrapAmount.toString(),
    approvalRequired: isApprovalNeeded({
      allowance: params.allowance,
      requiredAmount: params.config.amountRaw,
    }),
    allowanceRaw: params.allowance.toString(),
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function classifyContributionError(params: {
  stage: "check" | "associate" | "wrap" | "approve" | "contribute";
  error: unknown;
}): Error {
  const message = toErrorMessage(params.error);
  const lowered = message.toLowerCase();
  if (
    lowered.includes("user rejected") ||
    lowered.includes("rejected") ||
    lowered.includes("denied")
  ) {
    return new Error("Transaction rejected by user.");
  }

  if (params.stage === "associate") {
    return new Error(`WHBAR association failed: ${message}`);
  }
  if (params.stage === "wrap") {
    return new Error(`WHBAR deposit failed: ${message}`);
  }
  if (params.stage === "approve") {
    return new Error(`Funding token approval failed: ${message}`);
  }
  if (params.stage === "contribute") {
    return new Error(`Campaign contribution failed: ${message}`);
  }
  return new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil(params: {
  read: () => Promise<bigint>;
  target: bigint;
  attempts?: number;
  delayMs?: number;
}): Promise<bigint> {
  const attempts = params.attempts ?? 8;
  const delayMs = params.delayMs ?? 300;
  let latest = await params.read();
  if (latest >= params.target) return latest;

  for (let i = 1; i < attempts; i += 1) {
    await sleep(delayMs);
    latest = await params.read();
    if (latest >= params.target) return latest;
  }
  return latest;
}

export async function prepareCampaignContribution(params: {
  config: ContributionConfig;
  reads: ContributionReads;
}): Promise<CampaignContributionPreview> {
  if (isZeroOrNegativeAmount(params.config.amountRaw)) {
    throw new Error("Amount must be greater than zero");
  }

  const [whbarBalance, nativeHbarBalance, allowance] = await Promise.all([
    params.reads.readWhbarBalance(),
    params.reads.readNativeHbarBalance(),
    params.reads.readAllowance(),
  ]);

  const preview = buildContributionPreview({
    config: params.config,
    whbarBalance,
    nativeHbarBalance,
    allowance,
  });

  const wrapAmount = BigInt(preview.wrapAmountRaw);
  if (preview.usesWhbarFunding && wrapAmount > 0n) {
    const totalNativeRequired = wrapAmount + params.config.nativeHbarReserveRaw;
    if (nativeHbarBalance < totalNativeRequired) {
      throw new Error(
        `Insufficient native HBAR to wrap contribution shortfall. Need at least ${totalNativeRequired.toString()} tinybars including reserve, have ${nativeHbarBalance.toString()} tinybars.`,
      );
    }
  }

  return preview;
}

export async function executeCampaignContribution(params: {
  config: ContributionConfig;
  runtime: ContributionRuntime;
}): Promise<{ preview: CampaignContributionPreview; transactions: SponsoredTxResult[] }> {
  const preview = await prepareCampaignContribution({
    config: params.config,
    reads: params.runtime.reads,
  });

  const transactions: SponsoredTxResult[] = [];

  if (preview.usesWhbarFunding) {
    const wrapAmount = BigInt(preview.wrapAmountRaw);
    if (wrapAmount > 0n) {
      if (params.runtime.writes.associateFundingToken) {
        try {
          const associationTx = await params.runtime.writes.associateFundingToken();
          if (associationTx) {
            transactions.push(associationTx);
          }
        } catch (error) {
          throw classifyContributionError({ stage: "associate", error });
        }
      }

      try {
        transactions.push(await params.runtime.writes.wrapHbar(wrapAmount));
      } catch (error) {
        throw classifyContributionError({ stage: "wrap", error });
      }
    }

    // Re-read to guard against stale state before contribution execution.
    const whbarBalance = await pollUntil({
      read: params.runtime.reads.readWhbarBalance,
      target: params.config.amountRaw,
    });
    if (whbarBalance < params.config.amountRaw) {
      throw new Error(
        `WHBAR balance is insufficient after wrapping. Need ${params.config.amountRaw.toString()}, have ${whbarBalance.toString()}.`,
      );
    }
  }

  const allowanceBeforeApprove = await params.runtime.reads.readAllowance();
  if (isApprovalNeeded({ allowance: allowanceBeforeApprove, requiredAmount: params.config.amountRaw })) {
    try {
      transactions.push(await params.runtime.writes.approveFundingToken(params.config.amountRaw));
    } catch (error) {
      throw classifyContributionError({ stage: "approve", error });
    }
  }

  const finalAllowance = await pollUntil({
    read: params.runtime.reads.readAllowance,
    target: params.config.amountRaw,
  });
  if (finalAllowance < params.config.amountRaw) {
    throw new Error(
      `Funding token allowance is insufficient. Need ${params.config.amountRaw.toString()}, have ${finalAllowance.toString()}.`,
    );
  }

  try {
    transactions.push(
      await params.runtime.writes.contribute(params.config.amountRaw, params.config.recipient),
    );
  } catch (error) {
    throw classifyContributionError({ stage: "contribute", error });
  }

  if (params.runtime.refetchAfterSuccess) {
    await params.runtime.refetchAfterSuccess();
  }

  return {
    preview: {
      ...preview,
      approvalRequired: isApprovalNeeded({
        allowance: allowanceBeforeApprove,
        requiredAmount: params.config.amountRaw,
      }),
    },
    transactions,
  };
}
