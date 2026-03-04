import { AccountId, Client, PrivateKey } from "@hashgraph/sdk";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const LOCAL_NODE_ACCOUNT_ID = AccountId.fromString("0.0.3");

export interface HederaLocalConfig {
  consensusEndpoint: string;
  mirrorGrpcEndpoint: string;
  mirrorRestEndpoint: string;
  rpcEndpoint: string;
  wsEndpoint: string;
}

export interface HederaLocalAccount {
  accountId: AccountId;
  accountIdRaw: string;
  privateKey: PrivateKey;
}

export interface HederaLocalClientContext {
  client: Client;
  config: HederaLocalConfig;
  operator: HederaLocalAccount;
}

function firstNonEmptyValue(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function requireEnv(names: string[], description: string): string {
  const value = firstNonEmptyValue(names);
  if (!value) {
    throw new Error(
      `Missing ${description}. Set one of: ${names.join(", ")}. ` +
        "Use `pnpm hedera:local:keys` after starting the local node to populate libs/contracts/.env.local.",
    );
  }
  return value;
}

function parsePrivateKey(rawValue: string): PrivateKey {
  const value = rawValue.trim();
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  try {
    return PrivateKey.fromStringECDSA(normalized);
  } catch {
    return PrivateKey.fromString(normalized);
  }
}

export function getHederaLocalConfig(): HederaLocalConfig {
  return {
    consensusEndpoint: process.env.HEDERA_LOCAL_CONSENSUS_ENDPOINT?.trim() || "localhost:50211",
    mirrorGrpcEndpoint: process.env.HEDERA_LOCAL_MIRROR_GRPC_ENDPOINT?.trim() || "localhost:5600",
    mirrorRestEndpoint: process.env.HEDERA_LOCAL_MIRROR_REST_ENDPOINT?.trim() || "http://localhost:5551",
    rpcEndpoint: process.env.HEDERA_LOCAL_RPC_URL?.trim() || "http://localhost:7546",
    wsEndpoint: process.env.HEDERA_LOCAL_WS_URL?.trim() || "ws://localhost:8546",
  };
}

export function getOperatorFromEnv(): HederaLocalAccount {
  const accountIdRaw = requireEnv(
    ["HEDERA_OPERATOR_ID", "OPERATOR_ID", "HEDERA_LOCAL_ACCOUNT_ID_1"],
    "local Hedera operator account id",
  );
  const privateKeyRaw = requireEnv(
    [
      "HEDERA_OPERATOR_KEY",
      "OPERATOR_KEY",
      "HEDERA_PRIVATE_KEY",
      "DEPLOYER_PRIVATE_KEY",
      "HEDERA_LOCAL_PRIVATE_KEY_1",
    ],
    "local Hedera operator private key",
  );

  return {
    accountIdRaw,
    accountId: AccountId.fromString(accountIdRaw),
    privateKey: parsePrivateKey(privateKeyRaw),
  };
}

export function getSecondaryLocalAccount(): HederaLocalAccount {
  const accountIdRaw = requireEnv(["HEDERA_LOCAL_ACCOUNT_ID_2"], "local Hedera secondary account id");
  const privateKeyRaw = requireEnv(["HEDERA_LOCAL_PRIVATE_KEY_2"], "local Hedera secondary account private key");

  return {
    accountIdRaw,
    accountId: AccountId.fromString(accountIdRaw),
    privateKey: parsePrivateKey(privateKeyRaw),
  };
}

export function createHederaLocalClient(): HederaLocalClientContext {
  const config = getHederaLocalConfig();
  const operator = getOperatorFromEnv();

  const client = Client.forNetwork({
    [config.consensusEndpoint]: LOCAL_NODE_ACCOUNT_ID,
  }).setMirrorNetwork([config.mirrorGrpcEndpoint]);

  client.setOperator(operator.accountId, operator.privateKey);

  return {
    client,
    config,
    operator,
  };
}
