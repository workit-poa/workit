import { createPublicKey } from "node:crypto";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  type KeyMetadata
} from "@aws-sdk/client-kms";
import { AccountCreateTransaction, Client, Hbar, PublicKey } from "@hashgraph/sdk";

export interface ProvisionedWallet {
  hederaAccountId: string;
  kmsKeyId: string;
}

interface WalletProvisioningConfig {
  enabled: boolean;
  awsRegion: string;
  hederaNetwork: "testnet" | "mainnet";
  hederaOperatorId: string;
  hederaOperatorKey: string;
  initialBalanceHbar: number;
  createAlias: boolean;
  aliasPrefix: string;
  keyDescriptionPrefix: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getWalletProvisioningConfig(): WalletProvisioningConfig {
  const enabled = parseBoolean(process.env.HEDERA_WALLET_PROVISIONING_ENABLED, true);
  if (!enabled) {
    return {
      enabled,
      awsRegion: "us-east-1",
      hederaNetwork: "testnet",
      hederaOperatorId: "",
      hederaOperatorKey: "",
      initialBalanceHbar: 0,
      createAlias: false,
      aliasPrefix: "alias/workit-user",
      keyDescriptionPrefix: "Workit Hedera key for user"
    };
  }

  const network = process.env.HEDERA_NETWORK || "testnet";
  if (network !== "testnet" && network !== "mainnet") {
    throw new Error(`Unsupported HEDERA_NETWORK value: ${network}`);
  }

  return {
    enabled,
    awsRegion: requireEnv("AWS_REGION"),
    hederaNetwork: network,
    hederaOperatorId: requireEnv("HEDERA_OPERATOR_ID"),
    hederaOperatorKey: requireEnv("HEDERA_OPERATOR_KEY"),
    initialBalanceHbar: Number(process.env.HEDERA_NEW_ACCOUNT_INITIAL_HBAR || 1),
    createAlias: parseBoolean(process.env.HEDERA_KMS_CREATE_ALIAS, true),
    aliasPrefix: process.env.HEDERA_KMS_ALIAS_PREFIX || "alias/workit-user",
    keyDescriptionPrefix: process.env.HEDERA_KMS_KEY_DESCRIPTION_PREFIX || "Workit Hedera key for user"
  };
}

function publicKeyFromKmsSpki(spkiDerBytes: Uint8Array): PublicKey {
  const keyObject = createPublicKey({
    key: Buffer.from(spkiDerBytes),
    format: "der",
    type: "spki"
  });
  const jwk = keyObject.export({ format: "jwk" }) as { kty?: string; crv?: string; x?: string; y?: string };

  if (jwk.kty !== "EC" || jwk.crv !== "secp256k1" || !jwk.x || !jwk.y) {
    throw new Error("Unexpected KMS key type. Expected secp256k1 EC key.");
  }

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const uncompressed = Buffer.concat([Buffer.from([0x04]), x, y]);

  return PublicKey.fromBytesECDSA(uncompressed);
}

function getHederaClient(config: WalletProvisioningConfig): Client {
  const client = config.hederaNetwork === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(config.hederaOperatorId, config.hederaOperatorKey);
  return client;
}

async function createUserKmsKey(
  kms: KMSClient,
  cfg: WalletProvisioningConfig,
  userId: string
): Promise<string> {
  const createResp = await kms.send(
    new CreateKeyCommand({
      KeySpec: "ECC_SECG_P256K1",
      KeyUsage: "SIGN_VERIFY",
      Description: `${cfg.keyDescriptionPrefix} ${userId}`
    })
  );

  const metadata = createResp.KeyMetadata as KeyMetadata | undefined;
  const keyId = metadata?.Arn ?? metadata?.KeyId;
  if (!keyId || !metadata?.KeyId) {
    throw new Error("AWS KMS did not return a key id");
  }

  if (cfg.createAlias) {
    const normalizedPrefix = cfg.aliasPrefix.startsWith("alias/") ? cfg.aliasPrefix : `alias/${cfg.aliasPrefix}`;
    const aliasName = `${normalizedPrefix}-${userId}`.replace(/[^a-zA-Z0-9/_-]/g, "-");
    await kms.send(
      new CreateAliasCommand({
        AliasName: aliasName,
        TargetKeyId: metadata.KeyId
      })
    );
  }

  return keyId;
}

async function createKmsSigner(
  kms: KMSClient,
  keyId: string
): Promise<{ publicKey: PublicKey; sign: (message: Uint8Array) => Promise<Uint8Array> }> {
  const pubResp = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!pubResp.PublicKey) {
    throw new Error("KMS did not return public key bytes");
  }

  const publicKey = publicKeyFromKmsSpki(pubResp.PublicKey);
  const sign = async (message: Uint8Array): Promise<Uint8Array> => {
    const signResp = await kms.send(
      new SignCommand({
        KeyId: keyId,
        Message: Buffer.from(message),
        MessageType: "RAW",
        SigningAlgorithm: "ECDSA_SHA_256"
      })
    );
    if (!signResp.Signature) {
      throw new Error("KMS did not return signature bytes");
    }
    return new Uint8Array(signResp.Signature);
  };

  return { publicKey, sign };
}

export async function provisionManagedWalletForUser(userId: string): Promise<ProvisionedWallet | null> {
  const cfg = getWalletProvisioningConfig();
  if (!cfg.enabled) return null;

  const kms = new KMSClient({ region: cfg.awsRegion });
  const keyId = await createUserKmsKey(kms, cfg, userId);
  const signer = await createKmsSigner(kms, keyId);
  const hederaClient = getHederaClient(cfg);

  const tx = await new AccountCreateTransaction()
    .setKey(signer.publicKey)
    .setInitialBalance(new Hbar(cfg.initialBalanceHbar))
    .freezeWith(hederaClient);

  await tx.signWith(signer.publicKey, signer.sign);

  const txResponse = await tx.execute(hederaClient);
  const receipt = await txResponse.getReceipt(hederaClient);
  const accountId = receipt.accountId?.toString();
  if (!accountId) {
    throw new Error("Hedera account creation did not return an account id");
  }

  return {
    hederaAccountId: accountId,
    kmsKeyId: keyId
  };
}
