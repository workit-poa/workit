import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { KMSClient } from "@aws-sdk/client-kms";
import { provisionHederaAccountForUser } from "../walletProvisioning";
import {
  createHederaClientFromEnv,
  submitTopicMessageWithKmsSignature,
  submitTinybarTransferWithKmsSignature
} from "../hederaClient";
import { createKmsHederaSigner } from "../kmsSigner";

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

function parseDemoMode(value: string | undefined): "topic" | "transfer" {
  const normalized = (value || "topic").toLowerCase();
  if (normalized !== "topic" && normalized !== "transfer") {
    throw new Error(`Invalid DEMO_MODE "${value}". Expected "topic" or "transfer".`);
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

function parseBoolean(name: string, value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }

  throw new Error(`${name} must be a boolean value (true/false).`);
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
    const allowUnsafeDefaultKeyPolicy = parseBoolean(
      "ALLOW_UNSAFE_KMS_DEFAULT_POLICY",
      process.env.ALLOW_UNSAFE_KMS_DEFAULT_POLICY,
      false
    );
    const policyBindings = willProvisionNewAccount
      ? {
          accountId: (process.env.AWS_ACCOUNT_ID || "").trim(),
          keyAdminPrincipalArn: (process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN || "").trim(),
          runtimeSignerPrincipalArn: (process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN || "").trim()
        }
      : undefined;

    if (willProvisionNewAccount && !allowUnsafeDefaultKeyPolicy) {
      if (!policyBindings?.accountId || !policyBindings.keyAdminPrincipalArn || !policyBindings.runtimeSignerPrincipalArn) {
        throw new Error(
          "Missing key policy bindings for secure key creation. Set AWS_ACCOUNT_ID, KMS_KEY_ADMIN_PRINCIPAL_ARN, " +
            "and KMS_RUNTIME_SIGNER_PRINCIPAL_ARN, or set ALLOW_UNSAFE_KMS_DEFAULT_POLICY=true for local-only demos."
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
        policyBindings,
        allowUnsafeDefaultKeyPolicy
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

    if (demoMode === "transfer") {
      const transferResult = await submitTinybarTransferWithKmsSignature({
        client,
        signer,
        fromAccountId: accountId,
        toAccountId: process.env.DEMO_TRANSFER_TO_ACCOUNT_ID || operatorId,
        amountTinybar: transferTinybar,
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
