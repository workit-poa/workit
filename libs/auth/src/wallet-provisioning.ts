import { provisionHederaAccountForUser, type KmsKeyPolicyBindings } from "@workit-poa/hedera-kms-wallet";

export interface ProvisionedWallet {
  hederaAccountId: string;
  kmsKeyId: string;
  hederaPublicKeyFingerprint: string;
}

function resolveKmsPolicyBindingsFromEnv(): KmsKeyPolicyBindings | undefined {
  const accountId = (process.env.AWS_ACCOUNT_ID || "").trim();
  const keyAdminPrincipalArn = (process.env.KMS_KEY_ADMIN_PRINCIPAL_ARN || "").trim();
  const runtimeSignerPrincipalArn = (process.env.KMS_RUNTIME_SIGNER_PRINCIPAL_ARN || "").trim();

  if (!accountId && !keyAdminPrincipalArn && !runtimeSignerPrincipalArn) {
    return undefined;
  }

  if (!accountId || !keyAdminPrincipalArn || !runtimeSignerPrincipalArn) {
    throw new Error(
      "Incomplete KMS key policy bindings. Set AWS_ACCOUNT_ID, KMS_KEY_ADMIN_PRINCIPAL_ARN, and KMS_RUNTIME_SIGNER_PRINCIPAL_ARN."
    );
  }

  return {
    accountId,
    keyAdminPrincipalArn,
    runtimeSignerPrincipalArn
  };
}

export async function provisionManagedWalletForUser(userId: string, aliasUserId?: string): Promise<ProvisionedWallet> {
  const policyBindings = resolveKmsPolicyBindingsFromEnv();

  if (!policyBindings) {
    throw new Error(
      "Missing KMS key policy bindings for secure wallet provisioning. " +
        "Set AWS_ACCOUNT_ID, KMS_KEY_ADMIN_PRINCIPAL_ARN, and KMS_RUNTIME_SIGNER_PRINCIPAL_ARN, " 
    );
  }

  const provisioned = await provisionHederaAccountForUser({
    userId,
    aliasUserId,
    awsRegion: process.env.AWS_REGION,
    hederaNetwork: (process.env.HEDERA_NETWORK as "testnet" | "mainnet" | undefined) ?? "testnet",
    operatorId: process.env.OPERATOR_ID || process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY,
    aliasPrefix: process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix: process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user",
    allowKeyCreation: true,
    policyBindings
  });

  return {
    hederaAccountId: provisioned.accountId,
    kmsKeyId: provisioned.keyId,
    hederaPublicKeyFingerprint: provisioned.publicKeyFingerprint
  };
}
