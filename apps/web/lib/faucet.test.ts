import assert from "node:assert/strict";
import test from "node:test";
import type { ContractRunner, JsonRpcProvider } from "ethers";
import { claimDailyUsdcFaucetWithDeps } from "./faucet/server";
import {
  calculateAmountOutMinimumFromQuote,
  encodeSaucerV2Path,
  encodeSaucerV2SingleHopPath,
  swapHbarToUsdcViaSaucerV2,
  type ExactInputParams,
  type SaucerV2FaucetConfig
} from "./faucet/saucer-v2";

const BASE_CONFIG: SaucerV2FaucetConfig = {
  routerAddress: "0x0000000000000000000000000000000000159398",
  quoterAddress: "0x00000000000000000000000000000000001535b2",
  wrappedNativeAddress: "0x0000000000000000000000000000000000003ad1",
  usdcAddress: "0x0000000000000000000000000000000000001549",
  usdcDecimals: 6,
  usdcSymbol: "USDC",
  poolFee: 3000,
  slippageBps: 500n,
  deadlineSeconds: 600,
  hederaNetwork: "testnet",
  associationOperatorId: "0.0.5005",
  associationOperatorKey: "302e020100300506032b657004220420aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
};

test("quote to amountOutMinimum applies slippage bps", () => {
  const min = calculateAmountOutMinimumFromQuote(1_000_000n, 500n);
  assert.equal(min, 950_000n);
});

test("swap uses exactInput with encoded path and payable value amountIn", async () => {
  let capturedExactInput: { params: ExactInputParams; value: bigint } | null = null;

  const result = await swapHbarToUsdcViaSaucerV2(
    {
      provider: {} as JsonRpcProvider,
      operatorRunner: {} as ContractRunner,
      recipientAddress: "0x0000000000000000000000000000000000001111",
      recipientAccountId: "0.0.7001",
      recipientKmsKeyId: "kms-key-1",
      targetUsdcAmount: "1",
      config: BASE_CONFIG
    },
    {
      now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
      ensureRecipientAssociation: async () => undefined,
      resolveRoute: async () => ({
        hops: [
          {
            tokenIn: BASE_CONFIG.wrappedNativeAddress ?? "0x0000000000000000000000000000000000003ad1",
            fee: BASE_CONFIG.poolFee ?? 3000,
            tokenOut: BASE_CONFIG.usdcAddress
          }
        ]
      }),
      createContracts: () => ({
        quoteExactInput: async (_path: string, amountIn: bigint) => amountIn * 3_000n,
        exactInput: async (params: ExactInputParams, value: bigint) => {
          capturedExactInput = { params, value };
          return {
            transactionHash: "0xswap",
            status: 1
          };
        }
      })
    }
  );

  assert.ok(capturedExactInput, "expected exactInput to be called");
  const exactInputCall = capturedExactInput as { params: ExactInputParams; value: bigint };
  const expectedPath = encodeSaucerV2SingleHopPath(
    BASE_CONFIG.wrappedNativeAddress ?? "0x0000000000000000000000000000000000003ad1",
    BASE_CONFIG.poolFee ?? 3000,
    BASE_CONFIG.usdcAddress
  );
  assert.equal(exactInputCall.params.path, expectedPath);
  assert.equal(exactInputCall.params.recipient, "0x0000000000000000000000000000000000001111");
  assert.equal(exactInputCall.value, exactInputCall.params.amountIn);
  assert.equal(result.transactionHash, "0xswap");
  assert.equal(result.tokenSymbol, "USDC");
});

test("swap surfaces recipient not associated failures clearly", async () => {
  await assert.rejects(
    async () =>
      swapHbarToUsdcViaSaucerV2(
        {
          provider: {} as JsonRpcProvider,
          operatorRunner: {} as ContractRunner,
          recipientAddress: "0x0000000000000000000000000000000000001111",
          recipientAccountId: "0.0.7001",
          recipientKmsKeyId: "kms-key-1",
          targetUsdcAmount: "1",
          config: BASE_CONFIG
        },
        {
          now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
          ensureRecipientAssociation: async () => undefined,
          resolveRoute: async () => ({
            hops: [
              {
                tokenIn: BASE_CONFIG.wrappedNativeAddress ?? "0x0000000000000000000000000000000000003ad1",
                fee: BASE_CONFIG.poolFee ?? 3000,
                tokenOut: BASE_CONFIG.usdcAddress
              }
            ]
          }),
          createContracts: () => ({
            quoteExactInput: async (_path: string, amountIn: bigint) => amountIn * 3_000n,
            exactInput: async () => {
              throw new Error("TOKEN_NOT_ASSOCIATED_TO_ACCOUNT");
            }
          })
        }
      ),
    /not associated/i
  );
});

test("swap supports two-hop route encoding for exactInput", async () => {
  let capturedExactInput: { params: ExactInputParams; value: bigint } | null = null;
  const intermediateToken = "0x0000000000000000000000000000000000002ee0";

  await swapHbarToUsdcViaSaucerV2(
    {
      provider: {} as JsonRpcProvider,
      operatorRunner: {} as ContractRunner,
      recipientAddress: "0x0000000000000000000000000000000000001111",
      recipientAccountId: "0.0.7001",
      recipientKmsKeyId: "kms-key-1",
      targetUsdcAmount: "1",
      config: BASE_CONFIG
    },
    {
      now: () => new Date("2026-03-10T12:00:00.000Z").getTime(),
      ensureRecipientAssociation: async () => undefined,
      resolveRoute: async () => ({
        hops: [
          {
            tokenIn: BASE_CONFIG.wrappedNativeAddress ?? "0x0000000000000000000000000000000000003ad1",
            fee: 3000,
            tokenOut: intermediateToken
          },
          {
            tokenIn: intermediateToken,
            fee: 500,
            tokenOut: BASE_CONFIG.usdcAddress
          }
        ]
      }),
      createContracts: () => ({
        quoteExactInput: async (_path: string, amountIn: bigint) => amountIn * 2_000n,
        exactInput: async (params: ExactInputParams, value: bigint) => {
          capturedExactInput = { params, value };
          return {
            transactionHash: "0xswap-two-hop",
            status: 1
          };
        }
      })
    }
  );

  assert.ok(capturedExactInput, "expected exactInput to be called");
  const exactInputCall = capturedExactInput as { params: ExactInputParams; value: bigint };
  const expectedPath = encodeSaucerV2Path(
    [BASE_CONFIG.wrappedNativeAddress ?? "0x0000000000000000000000000000000000003ad1", intermediateToken, BASE_CONFIG.usdcAddress],
    [3000, 500]
  );
  assert.equal(exactInputCall.params.path, expectedPath);
  assert.equal(exactInputCall.value, exactInputCall.params.amountIn);
});

test("claimDailyUsdcFaucet happy path shape is preserved", async () => {
  const nextEligibleAt = new Date("2026-03-11T12:00:00.000Z");
  const result = await claimDailyUsdcFaucetWithDeps("user-1", {
    getFaucetStatus: async () => ({
      eligible: true,
      retryAfterSeconds: 0,
      nextEligibleAt: null
    }),
    performSwapToUser: async () => ({
      status: "claimed",
      amount: "1",
      recipient: "0x0000000000000000000000000000000000001111",
      transactionHash: "0xclaim",
      tokenSymbol: "USDC",
      nextEligibleAt
    })
  });

  assert.equal(result.status, "claimed");
  assert.equal(result.amount, "1");
  assert.equal(result.tokenSymbol, "USDC");
  assert.equal(result.recipient, "0x0000000000000000000000000000000000001111");
  assert.equal(result.transactionHash, "0xclaim");
  assert.equal(result.nextEligibleAt.toISOString(), nextEligibleAt.toISOString());
});
