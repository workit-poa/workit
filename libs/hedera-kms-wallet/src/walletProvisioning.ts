import { createHash } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { AccountCreateTransaction, Hbar } from "@hashgraph/sdk";
import { createUserKmsKey } from "./kmsKeyManager";
import { addKmsSignatureToFrozenTransaction, createHederaClient, createHederaClientFromEnv, type HederaNetwork } from "./hederaClient";
import { createKmsHederaSigner } from "./kmsSigner";

export interface ProvisionHederaAccountForUserParams {
  userId: string;
  awsRegion?: string;
  hederaNetwork?: HederaNetwork;
  operatorId?: string;
  operatorKey?: string;
  initialHbar?: number;
  aliasPrefix?: string;
  keyDescriptionPrefix?: string;
  existingKeyId?: string;
}

export interface ProvisionedHederaWallet {
  accountId: string;
  keyId: string;
  keyArn?: string;
  aliasName?: string;
  publicKeyCompressedHex: string;
  publicKeyUncompressedHex: string;
  publicKeyFingerprint: string;
  rotationEnabled: boolean;
  rotationNote?: string;
}

function fingerprintFromPublicKey(publicKeyCompressed: Uint8Array): string {
  return createHash("sha256").update(publicKeyCompressed).digest("hex");
}

export async function provisionHederaAccountForUser(
  params: ProvisionHederaAccountForUserParams
): Promise<ProvisionedHederaWallet> {
  const {
    userId,
    awsRegion = process.env.AWS_REGION,
    hederaNetwork = (process.env.HEDERA_NETWORK as HederaNetwork | undefined) ?? "testnet",
    operatorId = process.env.OPERATOR_ID || process.env.HEDERA_OPERATOR_ID,
    operatorKey = process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY,
    initialHbar = Number(process.env.HEDERA_NEW_ACCOUNT_INITIAL_HBAR || 1),
    aliasPrefix = process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix = process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user",
    existingKeyId
  } = params;

  if (!awsRegion) throw new Error("Missing AWS_REGION");
  if (!operatorId || !operatorKey) {
    throw new Error("Missing operator credentials: OPERATOR_ID/OPERATOR_KEY (or HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)");
  }

  const kms = new KMSClient({ region: awsRegion });
  const createdKey = existingKeyId
    ? {
        keyId: existingKeyId,
        keyArn: undefined,
        aliasName: undefined,
        rotationEnabled: false,
        rotationNote: "Existing key id was provided; rotation state should be managed externally."
      }
    : await createUserKmsKey({
        kms,
        userId,
        descriptionPrefix: keyDescriptionPrefix,
        aliasPrefix
      });

  const signer = await createKmsHederaSigner(kms, createdKey.keyId);
  const hederaClient = createHederaClient({
    network: hederaNetwork,
    operatorId,
    operatorKey
  });

  const accountCreateTx = await new AccountCreateTransaction()
    .setKey(signer.hederaPublicKey)
    .setInitialBalance(new Hbar(initialHbar))
    .freezeWith(hederaClient);

  await addKmsSignatureToFrozenTransaction(accountCreateTx, signer);

  const response = await accountCreateTx.execute(hederaClient);
  const receipt = await response.getReceipt(hederaClient);
  const accountId = receipt.accountId?.toString();

  if (!accountId) {
    throw new Error("Hedera account creation did not return an account id");
  }

  return {
    accountId,
    keyId: createdKey.keyId,
    keyArn: createdKey.keyArn,
    aliasName: createdKey.aliasName,
    publicKeyCompressedHex: signer.compressedPublicKey.toString("hex"),
    publicKeyUncompressedHex: signer.uncompressedPublicKey.toString("hex"),
    publicKeyFingerprint: fingerprintFromPublicKey(signer.compressedPublicKey),
    rotationEnabled: createdKey.rotationEnabled,
    rotationNote: createdKey.rotationNote
  };
}

export function loadWalletProvisioningConfigFromEnv() {
  const { client, network, operatorId } = createHederaClientFromEnv();
  client.close();
  return {
    network,
    operatorId,
    awsRegion: process.env.AWS_REGION || ""
  };
}
