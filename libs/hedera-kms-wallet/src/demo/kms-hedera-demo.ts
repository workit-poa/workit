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

function loadEnvForDemo(): void {
  const packageEnv = resolve(process.cwd(), ".env");
  const rootEnv = resolve(process.cwd(), "../../.env");

  loadDotenv({ path: rootEnv, override: false });
  loadDotenv({ path: packageEnv, override: false });
}

async function run(): Promise<void> {
  loadEnvForDemo();

  const awsRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
  if (!awsRegion) {
    throw new Error("Missing required env var: AWS_REGION (or AWS_DEFAULT_REGION)");
  }
  const userId = process.env.DEMO_USER_ID || `demo-user-${Date.now()}`;
  const message = process.env.DEMO_TOPIC_MESSAGE || `workit-kms-demo ${new Date().toISOString()}`;
  const transferTinybar = Number(process.env.DEMO_TRANSFER_TINYBAR || 1);
  const demoMode = process.env.DEMO_MODE || "topic";

  const { client, network, operatorId } = createHederaClientFromEnv();
  const kms = new KMSClient({ region: awsRegion });

  const existingKeyId = process.env.KMS_KEY_ID;
  const existingAccountId = process.env.HEDERA_USER_ACCOUNT_ID;

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
      initialHbar: Number(process.env.HEDERA_NEW_ACCOUNT_INITIAL_HBAR || 1)
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

  const signer = await createKmsHederaSigner(kms, keyId);

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

  client.close();
}

run().catch(error => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});
