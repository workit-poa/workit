import { createHash } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { AccountCreateTransaction, Hbar } from "@hashgraph/sdk";
import { createUserKmsKey } from "./kmsKeyManager";
import { addKmsSignatureToFrozenTransaction, createHederaClient, type HederaNetwork } from "./hederaClient";
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
    initialHbar,
    aliasPrefix = process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix = process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user",
    existingKeyId
  } = params;
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required");
  }

  if (!awsRegion) throw new Error("Missing AWS_REGION");
  if (!operatorId || !operatorKey) {
    throw new Error("Missing operator credentials: OPERATOR_ID/OPERATOR_KEY (or HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)");
  }
  if (initialHbar !== undefined && (!Number.isFinite(initialHbar) || initialHbar < 0)) {
    throw new Error("initialHbar must be a non-negative number when provided");
  }

  const normalizedExistingKeyId = existingKeyId?.trim();

  const kms = new KMSClient({ region: awsRegion });
  let hederaClient: ReturnType<typeof createHederaClient> | undefined;

  try {
    const createdKey = normalizedExistingKeyId
      ? {
          keyId: normalizedExistingKeyId,
          keyArn: undefined,
          aliasName: undefined,
          rotationEnabled: false,
          rotationNote: "Existing key id was provided; rotation state should be managed externally."
        }
      : await createUserKmsKey({
          kms,
          userId: normalizedUserId,
          descriptionPrefix: keyDescriptionPrefix,
          aliasPrefix
        });

    const signer = await createKmsHederaSigner(kms, createdKey.keyId);
    hederaClient = createHederaClient({
      network: hederaNetwork,
      operatorId,
      operatorKey
    });

    let accountCreateTx = new AccountCreateTransaction().setKey(signer.hederaPublicKey);
    if (initialHbar !== undefined && initialHbar > 0) {
      accountCreateTx = accountCreateTx.setInitialBalance(new Hbar(initialHbar));
    }
    accountCreateTx = await accountCreateTx.freezeWith(hederaClient);

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
  } finally {
    kms.destroy();
    hederaClient?.close();
  }
}
