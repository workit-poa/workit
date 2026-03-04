import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { KMSClient } from "@aws-sdk/client-kms";
import { ContractFactory, getAddress, type InterfaceAbi } from "ethers";
import {
  createHederaJsonRpcProvider,
  createHederaClientFromEnv,
  createKmsHederaSigner,
  mirrorLinkForTransaction,
  provisionHederaAccountForUser,
  resolveHederaEvmConnection,
  signEvmTransactionWithKmsWallet,
  submitTopicMessageWithKmsSignature,
  submitTinybarTransferWithKmsSignature,
} from "@workit-poa/hedera-kms-wallet";

let activeCleanup: (() => Promise<void>) | undefined;
let interrupted = false;

process.once("SIGINT", () => {
  interrupted = true;
  console.error("\nSIGINT received, shutting down...");

  if (!activeCleanup) {
    process.exit(0);
  }

  void activeCleanup().finally(() => {
    process.exit(0);
  });
});

function loadEnvForDemo(): void {
  const packageEnv = resolve(process.cwd(), ".env");
  const rootEnv = resolve(process.cwd(), "../../.env");

  loadDotenv({ path: rootEnv, override: false });
  loadDotenv({ path: packageEnv, override: false });
}

function parseDemoMode(value: string | undefined): "deploy" | "topic" | "transfer" {
  const normalized = (value || "deploy").toLowerCase();
  if (normalized !== "deploy" && normalized !== "topic" && normalized !== "transfer") {
    throw new Error(`Invalid DEMO_MODE "${value}". Expected "deploy", "topic", or "transfer".`);
  }
  return normalized;
}

function parseOptionalNonNegativeNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative number when provided.`);
  }

  return parsed;
}

function parsePositiveSafeInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }

  return parsed;
}

function parseDeployArgs(value: string | undefined): unknown[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("DEMO_DEPLOY_ARGS_JSON must be valid JSON.", { cause: error });
  }

  if (!Array.isArray(parsed)) {
    throw new Error("DEMO_DEPLOY_ARGS_JSON must be a JSON array.");
  }

  return parsed;
}

interface HardhatArtifact {
  contractName?: string;
  abi: InterfaceAbi;
  bytecode: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mirrorRestCandidates(network: "testnet" | "mainnet"): string[] {
  const envMirror = process.env.DEMO_MIRROR_REST_URL?.trim();
  if (envMirror) {
    return [envMirror.replace(/\/+$/, "")];
  }

  if (network === "testnet") {
    return ["https://testnet.mirrornode.hedera.com"];
  }

  return ["https://mainnet-public.mirrornode.hedera.com", "https://mainnet.mirrornode.hedera.com"];
}

async function resolveMirrorLinkForEvmHash(
  network: "testnet" | "mainnet",
  txHash: string,
): Promise<{ hashscanLink?: string; mirrorResultUrl?: string }> {
  const normalizedHash = txHash.trim().toLowerCase();
  if (!normalizedHash) {
    return {};
  }

  const candidates = mirrorRestCandidates(network);
  const maxAttempts = 6;
  const delayMs = 1500;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const base of candidates) {
      const mirrorResultUrl = `${base}/api/v1/contracts/results/${normalizedHash}`;
      try {
        const response = await fetch(mirrorResultUrl);
        if (!response.ok) {
          continue;
        }

        const payload = (await response.json()) as { transaction_id?: string };
        const transactionId = payload.transaction_id?.trim();
        if (transactionId) {
          return {
            hashscanLink: mirrorLinkForTransaction(network, transactionId),
            mirrorResultUrl,
          };
        }
      } catch {
        // Ignore transient mirror fetch issues and continue retries.
      }
    }

    await sleep(delayMs);
  }

  return {};
}

async function readHardhatArtifact(artifactPath: string): Promise<HardhatArtifact> {
  let raw: string;
  try {
    raw = await readFile(artifactPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read Hardhat artifact at "${artifactPath}". ` +
        "Run `pnpm --filter @workit-poa/contracts compile` and verify DEMO_HARDHAT_ARTIFACT_PATH.",
      { cause: error }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Artifact file is not valid JSON: "${artifactPath}"`, { cause: error });
  }

  const artifact = parsed as Partial<HardhatArtifact>;
  if (!artifact?.abi || !Array.isArray(artifact.abi) || typeof artifact.bytecode !== "string") {
    throw new Error(`Artifact "${artifactPath}" must contain both 'abi' and 'bytecode'.`);
  }

  return {
    contractName: artifact.contractName,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  };
}

async function run(): Promise<void> {
  loadEnvForDemo();

  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!awsRegion) {
    throw new Error("Missing required env var: AWS_REGION (or AWS_DEFAULT_REGION)");
  }
  const userId = process.env.DEMO_USER_ID || `demo-user-${Date.now()}`;
  const message = process.env.DEMO_TOPIC_MESSAGE || `workit-kms-demo ${new Date().toISOString()}`;
  const transferTinybar = parsePositiveSafeInteger("DEMO_TRANSFER_TINYBAR", process.env.DEMO_TRANSFER_TINYBAR, 1);
  const demoMode = parseDemoMode(process.env.DEMO_MODE);
  const deployArgs = parseDeployArgs(process.env.DEMO_DEPLOY_ARGS_JSON);
  const artifactPath =
    process.env.DEMO_HARDHAT_ARTIFACT_PATH ||
    resolve(
      process.cwd(),
      "../../libs/contracts/artifacts/contracts/uniswap-v2/UniswapV2Pair.sol/UniswapV2Pair.json",
    );
  const demoEvmRpcUrl = process.env.DEMO_EVM_RPC_URL?.trim() || undefined;
  const initialHbar = parseOptionalNonNegativeNumber("HEDERA_NEW_ACCOUNT_INITIAL_HBAR", process.env.HEDERA_NEW_ACCOUNT_INITIAL_HBAR);

  const { client, network, operatorId } = createHederaClientFromEnv();
  const kms = new KMSClient({ region: awsRegion });
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = async (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = Promise.resolve().then(() => {
        kms.destroy();
        client.close();
      });
    }

    await cleanupPromise;
  };

  activeCleanup = cleanup;

  try {
    const existingKeyId = process.env.KMS_KEY_ID;
    const existingAccountId = process.env.HEDERA_USER_ACCOUNT_ID;
    const willProvisionNewAccount = !existingKeyId || !existingAccountId;

    if (willProvisionNewAccount && (initialHbar === undefined || initialHbar <= 0)) {
      throw new Error(
        "HEDERA_NEW_ACCOUNT_INITIAL_HBAR must be > 0 when provisioning a new demo account. " +
          "Set HEDERA_NEW_ACCOUNT_INITIAL_HBAR or provide both KMS_KEY_ID and HEDERA_USER_ACCOUNT_ID for an already funded account."
      );
    }
    const policyBindings = willProvisionNewAccount
      ? {
          accountId: (process.env.AWS_ACCOUNT_ID || "").trim(),
          keyAdminPrincipalArn: (process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN || "").trim(),
          runtimeSignerPrincipalArn: (process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN || "").trim()
        }
      : undefined;

    if (willProvisionNewAccount) {
      if (!policyBindings?.accountId || !policyBindings.keyAdminPrincipalArn || !policyBindings.runtimeSignerPrincipalArn) {
        throw new Error(
          "Missing key policy bindings for secure key creation. Set AWS_ACCOUNT_ID, KMS_KEY_ADMIN_PRINCIPAL_ARN, " +
            "and KMS_RUNTIME_SIGNER_PRINCIPAL_ARN."
        );
      }
    }

    let keyId = existingKeyId;
    let accountId = existingAccountId;

    if (!keyId || !accountId) {
      const provisioned = await provisionHederaAccountForUser({
        userId,
        existingKeyId,
        awsRegion,
        hederaNetwork: network,
        operatorId,
        operatorKey: process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY,
        initialHbar,
        allowKeyCreation: true,
        policyBindings
      });

      keyId = provisioned.keyId;
      accountId = provisioned.accountId;

      console.log("Provisioned managed wallet");
      console.log(`  accountId: ${provisioned.accountId}`);
      console.log(`  keyId: ${provisioned.keyId}`);
      console.log(`  compressedPublicKey: ${provisioned.publicKeyCompressedHex}`);
      console.log(`  fingerprint: ${provisioned.publicKeyFingerprint}`);
      if (provisioned.rotationNote) {
        console.log(`  rotationNote: ${provisioned.rotationNote}`);
      }
    }

    if (!keyId || !accountId) {
      throw new Error("Failed to resolve keyId/accountId for demo");
    }

    const signer = await createKmsHederaSigner({
      kms,
      keyId
    });

    console.log("Loaded KMS-backed signer");
    console.log(`  keyId: ${keyId}`);
    console.log(`  accountId: ${accountId}`);
    console.log(`  compressedPublicKey: ${signer.compressedPublicKey.toString("hex")}`);

    if (demoMode === "deploy") {
      const artifact = await readHardhatArtifact(artifactPath);
      const evmConnection = resolveHederaEvmConnection({ network, rpcUrl: demoEvmRpcUrl });
      const provider = createHederaJsonRpcProvider(evmConnection);
      const deployerAddress = getAddress(signer.hederaPublicKey.toEvmAddress());
      const networkInfo = await provider.getNetwork();
      const nonce = await provider.getTransactionCount(deployerAddress, "pending");

      const factory = new ContractFactory(artifact.abi, artifact.bytecode);
      const deployTx = await factory.getDeployTransaction(...deployArgs);
      if (!deployTx.data) {
        throw new Error(`Hardhat artifact "${artifactPath}" does not contain deployable bytecode.`);
      }

      let estimatedGas = 1_500_000n;
      try {
        estimatedGas = await provider.estimateGas({
          from: deployerAddress,
          data: deployTx.data,
          value: deployTx.value ?? 0n
        });
      } catch {
        // Fall back to a conservative gas limit when estimation is unavailable.
      }
      const gasLimit = (estimatedGas * 120n) / 100n;
      const feeData = await provider.getFeeData();

      const unsignedDeployTx = {
        ...deployTx,
        chainId: Number(networkInfo.chainId),
        nonce,
        gasLimit,
      };

      if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
        Object.assign(unsignedDeployTx, {
          type: 2,
          maxFeePerGas: feeData.maxFeePerGas,
          maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        });
      } else {
        Object.assign(unsignedDeployTx, {
          gasPrice: feeData.gasPrice ?? 1n
        });
      }

      const { signedTransaction } = await signEvmTransactionWithKmsWallet({
        kms,
        keyId,
        provider,
        transaction: unsignedDeployTx
      });
      const txResponse = await provider.broadcastTransaction(signedTransaction);
      const receipt = await txResponse.wait();
      if (!receipt?.contractAddress) {
        throw new Error("Deployment receipt did not include contractAddress.");
      }

      console.log("Deployed Hardhat contract using KMS-backed wallet (EVM)");
      console.log(`  contract: ${artifact.contractName ?? "UnknownContract"}`);
      console.log(`  address: ${receipt.contractAddress}`);
      console.log(`  txHash: ${txResponse.hash}`);
      console.log(`  deployer: ${deployerAddress}`);
      console.log(`  chainId: ${networkInfo.chainId}`);
      console.log(`  rpcUrl: ${evmConnection.rpcUrl}`);
      const mirror = await resolveMirrorLinkForEvmHash(network, txResponse.hash);
      if (mirror.hashscanLink) {
        console.log(`  mirror: ${mirror.hashscanLink}`);
      }
      if (mirror.mirrorResultUrl) {
        console.log(`  mirrorResult: ${mirror.mirrorResultUrl}`);
      }
    } else if (demoMode === "transfer") {
      const transferResult = await submitTinybarTransferWithKmsSignature({
        client,
        signer,
        fromAccountId: accountId,
        toAccountId: process.env.DEMO_TRANSFER_TO_ACCOUNT_ID || operatorId,
        amountTinybar: transferTinybar,
        payerAccountId: accountId,
        network
      });

      console.log("Submitted transfer transaction with KMS signature");
      console.log(`  txId: ${transferResult.transactionId}`);
      console.log(`  status: ${transferResult.receiptStatus}`);
      if (transferResult.mirrorLink) {
        console.log(`  mirror: ${transferResult.mirrorLink}`);
      }
    } else {
      const topicResult = await submitTopicMessageWithKmsSignature({
        client,
        signer,
        topicMemo: "workit-kms-demo-topic",
        message,
        payerAccountId: accountId,
        network
      });

      console.log("Submitted topic message transaction with KMS signature");
      console.log(`  topicId: ${topicResult.topicId}`);
      console.log(`  txId: ${topicResult.transactionId}`);
      console.log(`  status: ${topicResult.receiptStatus}`);
      if (topicResult.mirrorLink) {
        console.log(`  mirror: ${topicResult.mirrorLink}`);
      }
    }
  } finally {
    await cleanup();
    activeCleanup = undefined;
  }
}

run().catch(error => {
  if (interrupted) {
    return;
  }

  console.error("Demo failed:", error);
  process.exitCode = 1;
});
