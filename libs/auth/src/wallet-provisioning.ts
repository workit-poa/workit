import { provisionHederaAccountForUser } from "@workit/hedera-kms-wallet";

export interface ProvisionedWallet {
  hederaAccountId: string;
  kmsKeyId: string;
  hederaPublicKeyFingerprint: string;
}

export async function provisionManagedWalletForUser(userId: string): Promise<ProvisionedWallet> {
  const provisioned = await provisionHederaAccountForUser({
    userId,
    awsRegion: process.env.AWS_REGION,
    hederaNetwork: (process.env.HEDERA_NETWORK as "testnet" | "mainnet" | undefined) ?? "testnet",
    operatorId: process.env.OPERATOR_ID || process.env.HEDERA_OPERATOR_ID,
    operatorKey: process.env.OPERATOR_KEY || process.env.HEDERA_OPERATOR_KEY,
    aliasPrefix: process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix: process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user"
  });

  return {
    hederaAccountId: provisioned.accountId,
    kmsKeyId: provisioned.keyId,
    hederaPublicKeyFingerprint: provisioned.publicKeyFingerprint
  };
}
