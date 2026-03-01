import { createHash } from "node:crypto";
import { KMSClient } from "@aws-sdk/client-kms";
import { AccountCreateTransaction, AccountId, AccountUpdateTransaction, Hbar } from "@hashgraph/sdk";
import { createUserKmsKey, type KmsAuditLogger, type KmsKeyPolicyBindings } from "./kmsKeyManager";
import {
  addKmsSignatureToFrozenTransaction,
  createHederaClient,
  executeSignedTransaction,
  mirrorLinkForTransaction,
  type HederaNetwork
} from "./hederaClient";
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
  allowKeyCreation?: boolean;
  keyPolicy?: Record<string, unknown>;
  policyBindings?: KmsKeyPolicyBindings;
  allowUnsafeDefaultKeyPolicy?: boolean;
  auditLogger?: KmsAuditLogger;
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

export interface RotateHederaAccountKmsKeyParams {
  userId: string;
  accountId: string;
  currentKeyId: string;
  replacementKeyId?: string;
  awsRegion?: string;
  hederaNetwork?: HederaNetwork;
  operatorId?: string;
  operatorKey?: string;
  aliasPrefix?: string;
  keyDescriptionPrefix?: string;
  keyPolicy?: Record<string, unknown>;
  policyBindings?: KmsKeyPolicyBindings;
  allowUnsafeDefaultKeyPolicy?: boolean;
  auditLogger?: KmsAuditLogger;
}

export interface RotatedHederaWalletKey {
  accountId: string;
  previousKeyId: string;
  previousKeyArn: string;
  previousPublicKeyCompressedHex: string;
  previousPublicKeyFingerprint: string;
  keyId: string;
  keyArn?: string;
  aliasName?: string;
  publicKeyCompressedHex: string;
  publicKeyUncompressedHex: string;
  publicKeyFingerprint: string;
  rotationEnabled: boolean;
  rotationNote?: string;
  transactionId: string;
  receiptStatus: string;
  mirrorLink: string;
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
    existingKeyId,
    allowKeyCreation = false,
    keyPolicy,
    policyBindings,
    allowUnsafeDefaultKeyPolicy = false,
    auditLogger
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
  if (!normalizedExistingKeyId && !allowKeyCreation) {
    throw new Error(
      "existingKeyId is required unless allowKeyCreation=true. " +
        "Provision keys in an admin workflow and pass existingKeyId for runtime flows."
    );
  }

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
          aliasPrefix,
          keyPolicy,
          policyBindings,
          allowUnsafeDefaultKeyPolicy,
          auditLogger
        });

    const signer = await createKmsHederaSigner({
      kms,
      keyId: createdKey.keyId,
      auditLogger
    });
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
    const { receipt } = await executeSignedTransaction(hederaClient, accountCreateTx);
    const accountId = receipt.accountId?.toString();

    if (!accountId) {
      throw new Error("Hedera account creation did not return an account id");
    }

    return {
      accountId,
      keyId: createdKey.keyId,
      keyArn: createdKey.keyArn ?? signer.keyArn,
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

export async function rotateHederaAccountKmsKey(
  params: RotateHederaAccountKmsKeyParams
): Promise<RotatedHederaWalletKey> {
  const {
    userId,
    accountId,
    currentKeyId,
    replacementKeyId,
    awsRegion = process.env.AWS_REGION,
    hederaNetwork = (process.env.HEDERA_NETWORK as HederaNetwork | undefined) ?? "testnet",
    operatorId = process.env.OPERATOR_ID || process.env.HEDERA_OPERATOR_ID,
    operatorKey = process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY,
    aliasPrefix = process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix = process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user",
    keyPolicy,
    policyBindings,
    allowUnsafeDefaultKeyPolicy = false,
    auditLogger
  } = params;

  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required");
  }
  const normalizedAccountId = accountId.trim();
  if (!normalizedAccountId) {
    throw new Error("accountId is required");
  }
  const normalizedCurrentKeyId = currentKeyId.trim();
  if (!normalizedCurrentKeyId) {
    throw new Error("currentKeyId is required");
  }

  if (!awsRegion) throw new Error("Missing AWS_REGION");
  if (!operatorId || !operatorKey) {
    throw new Error("Missing operator credentials: OPERATOR_ID/OPERATOR_KEY (or HEDERA_OPERATOR_ID/HEDERA_OPERATOR_KEY)");
  }

  const normalizedReplacementKeyId = replacementKeyId?.trim();
  const kms = new KMSClient({ region: awsRegion });
  let hederaClient: ReturnType<typeof createHederaClient> | undefined;

  try {
    const replacementKey = normalizedReplacementKeyId
      ? {
          keyId: normalizedReplacementKeyId,
          keyArn: undefined,
          aliasName: undefined,
          rotationEnabled: false,
          rotationNote: "Replacement key id was provided; key lifecycle and policy controls are managed externally."
        }
      : await createUserKmsKey({
          kms,
          userId: normalizedUserId,
          descriptionPrefix: keyDescriptionPrefix,
          aliasPrefix,
          keyPolicy,
          policyBindings,
          allowUnsafeDefaultKeyPolicy,
          auditLogger
        });

    const currentSigner = await createKmsHederaSigner({
      kms,
      keyId: normalizedCurrentKeyId,
      auditLogger
    });
    const replacementSigner = await createKmsHederaSigner({
      kms,
      keyId: replacementKey.keyId,
      auditLogger
    });

    hederaClient = createHederaClient({
      network: hederaNetwork,
      operatorId,
      operatorKey
    });

    let accountUpdateTx = new AccountUpdateTransaction()
      .setAccountId(AccountId.fromString(normalizedAccountId))
      .setKey(replacementSigner.hederaPublicKey);
    accountUpdateTx = await accountUpdateTx.freezeWith(hederaClient);

    // Hedera key updates are explicitly co-signed by both the current and replacement keys.
    await addKmsSignatureToFrozenTransaction(accountUpdateTx, currentSigner);
    await addKmsSignatureToFrozenTransaction(accountUpdateTx, replacementSigner);

    const { response, receipt } = await executeSignedTransaction(hederaClient, accountUpdateTx);
    const transactionId = response.transactionId.toString();

    return {
      accountId: normalizedAccountId,
      previousKeyId: currentSigner.keyId,
      previousKeyArn: currentSigner.keyArn,
      previousPublicKeyCompressedHex: currentSigner.compressedPublicKey.toString("hex"),
      previousPublicKeyFingerprint: fingerprintFromPublicKey(currentSigner.compressedPublicKey),
      keyId: replacementKey.keyId,
      keyArn: replacementKey.keyArn ?? replacementSigner.keyArn,
      aliasName: replacementKey.aliasName,
      publicKeyCompressedHex: replacementSigner.compressedPublicKey.toString("hex"),
      publicKeyUncompressedHex: replacementSigner.uncompressedPublicKey.toString("hex"),
      publicKeyFingerprint: fingerprintFromPublicKey(replacementSigner.compressedPublicKey),
      rotationEnabled: replacementKey.rotationEnabled,
      rotationNote: replacementKey.rotationNote,
      transactionId,
      receiptStatus: receipt.status.toString(),
      mirrorLink: mirrorLinkForTransaction(hederaNetwork, transactionId)
    };
  } finally {
    kms.destroy();
    hederaClient?.close();
  }
}
