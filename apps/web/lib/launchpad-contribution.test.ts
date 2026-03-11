import assert from "node:assert/strict";
import test from "node:test";
import {
  computeWrapShortfall,
  executeCampaignContribution,
  isApprovalNeeded,
  prepareCampaignContribution,
  type ContributionConfig,
  type ContributionRuntime
} from "./launchpad/contribution";

function baseConfig(overrides: Partial<ContributionConfig> = {}): ContributionConfig {
  return {
    campaignAddress: "0x0000000000000000000000000000000000001000",
    fundingToken: "0x0000000000000000000000000000000000003ad1",
    amountInput: "1",
    amountRaw: 100_000_000n,
    fundingTokenDecimals: 8,
    recipient: "0x0000000000000000000000000000000000002000",
    nativeHbarReserveRaw: 5_000_000n,
    isWhbarFundingToken: true,
    ...overrides
  };
}

function createRuntime(params: {
  whbarBalance: bigint;
  nativeHbarBalance: bigint;
  allowance: bigint;
  wrapTxId?: string;
  approveTxId?: string;
  contributeTxId?: string;
}) {
  const calls: string[] = [];
  let whbarBalance = params.whbarBalance;
  let allowance = params.allowance;

  const runtime: ContributionRuntime = {
    reads: {
      readWhbarBalance: async () => whbarBalance,
      readNativeHbarBalance: async () => params.nativeHbarBalance,
      readAllowance: async () => allowance
    },
    writes: {
      wrapHbar: async amount => {
        calls.push(`wrap:${amount.toString()}`);
        whbarBalance += amount;
        return {
          type: "wrap_hbar",
          transactionId: params.wrapTxId ?? "wrap-tx",
          mirrorLink: "https://example.com/wrap"
        };
      },
      approveFundingToken: async () => {
        calls.push("approve");
        allowance = 2n ** 255n;
        return {
          type: "approve",
          transactionId: params.approveTxId ?? "approve-tx",
          mirrorLink: "https://example.com/approve"
        };
      },
      contribute: async amount => {
        calls.push(`contribute:${amount.toString()}`);
        return {
          type: "contribute",
          transactionId: params.contributeTxId ?? "contribute-tx",
          mirrorLink: "https://example.com/contribute"
        };
      }
    }
  };

  return { runtime, calls };
}

test("computeWrapShortfall returns expected values", () => {
  assert.equal(computeWrapShortfall({ requiredAmount: 10n, whbarBalance: 10n }), 0n);
  assert.equal(computeWrapShortfall({ requiredAmount: 10n, whbarBalance: 3n }), 7n);
});

test("isApprovalNeeded checks allowance correctly", () => {
  assert.equal(isApprovalNeeded({ allowance: 10n, requiredAmount: 10n }), false);
  assert.equal(isApprovalNeeded({ allowance: 9n, requiredAmount: 10n }), true);
});

test("enough WHBAR skips wrap and approval when allowance is sufficient", async () => {
  const config = baseConfig();
  const { runtime, calls } = createRuntime({
    whbarBalance: 100_000_000n,
    nativeHbarBalance: 100_000_000n,
    allowance: 100_000_000n
  });

  const result = await executeCampaignContribution({ config, runtime });

  assert.deepEqual(calls, ["contribute:100000000"]);
  assert.equal(result.preview.wrapAmountRaw, "0");
  assert.equal(result.preview.approvalRequired, false);
});

test("partial WHBAR wraps shortfall then approves then contributes", async () => {
  const config = baseConfig();
  const { runtime, calls } = createRuntime({
    whbarBalance: 25_000_000n,
    nativeHbarBalance: 100_000_000n,
    allowance: 0n
  });

  const result = await executeCampaignContribution({ config, runtime });

  assert.deepEqual(calls, ["wrap:75000000", "approve", "contribute:100000000"]);
  assert.equal(result.preview.wrapAmountRaw, "75000000");
  assert.equal(result.transactions.length, 3);
});

test("zero WHBAR wraps full amount then contributes", async () => {
  const config = baseConfig();
  const { runtime, calls } = createRuntime({
    whbarBalance: 0n,
    nativeHbarBalance: 120_000_000n,
    allowance: 200_000_000n
  });

  await executeCampaignContribution({ config, runtime });

  assert.deepEqual(calls, ["wrap:100000000", "contribute:100000000"]);
});

test("insufficient native HBAR fails preflight", async () => {
  const config = baseConfig();
  const reads = {
    readWhbarBalance: async () => 0n,
    readNativeHbarBalance: async () => 50_000_000n,
    readAllowance: async () => 0n
  };

  await assert.rejects(
    async () => prepareCampaignContribution({ config, reads }),
    /Insufficient native HBAR to wrap contribution shortfall/
  );
});

test("non-WHBAR flow does not attempt wrapping", async () => {
  const config = baseConfig({
    isWhbarFundingToken: false,
    fundingToken: "0x0000000000000000000000000000000000003000"
  });
  const { runtime, calls } = createRuntime({
    whbarBalance: 0n,
    nativeHbarBalance: 0n,
    allowance: 0n
  });

  const result = await executeCampaignContribution({ config, runtime });

  assert.deepEqual(calls, ["approve", "contribute:100000000"]);
  assert.equal(result.preview.wrapAmountRaw, "0");
});
