import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@hashgraph/system-contracts-forking/plugin";
import dotenv from "dotenv";
import {
  deployContract
} from "./scripts/utils/deploy-contracts";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

type HederaNetworkName = "hardhat" | "hederaLocal" | "hederaTestnet" | "hederaPreviewnet" | "hederaMainnet";

const HEDERA_RPC_DEFAULTS = {
  local: "http://localhost:7546",
  testnet: "https://testnet.hashio.io/api",
  previewnet: "https://previewnet.hashio.io/api",
  mainnet: "https://mainnet.hashio.io/api",
} as const;

const HEDERA_CHAIN_IDS = {
  local: 298,
  testnet: 296,
  previewnet: 297,
  mainnet: 295,
} as const;

function normalizePrivateKey(value?: string): string | undefined {
  if (!value) return undefined;
  return value.startsWith("0x") ? value : `0x${value}`;
}

function collectAccounts(): string[] {
  const explicitList = (process.env.HEDERA_PRIVATE_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const candidates = [
    process.env.HEDERA_PRIVATE_KEY,
    process.env.DEPLOYER_PRIVATE_KEY,
    process.env.HEDERA_LOCAL_PRIVATE_KEY_1,
    process.env.HEDERA_LOCAL_PRIVATE_KEY_2,
    ...explicitList,
  ];

  const unique = new Set<string>();
  for (const value of candidates) {
    const normalized = normalizePrivateKey(value);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
}

const accounts = collectAccounts();

const defaultNetworkMap: Record<string, HederaNetworkName> = {
  hardhat: "hardhat",
  local: "hederaLocal",
  localhost: "hederaLocal",
  testnet: "hederaTestnet",
  previewnet: "hederaPreviewnet",
  mainnet: "hederaMainnet",
};

const defaultNetwork = defaultNetworkMap[(process.env.HEDERA_NETWORK ?? "hardhat").toLowerCase()] ?? "hardhat";

task("contracts:deploy", "Deploy a contract by name or FQN")
  .addParam("id", "Contract name or fully-qualified name")
  .addOptionalParam("args", "JSON array of constructor args", "[]")
  .setAction(async (args, hre) => {
    const parsedArgs = JSON.parse(args.args) as unknown[];
    const deployed = await deployContract(hre, {
      contractId: args.id,
      args: parsedArgs,
    });
    console.log(`deployed=${await deployed.getAddress()}`);
  });

const config: HardhatUserConfig = {
  defaultNetwork,
  solidity: {
    compilers: [
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
      {
        version: "0.8.28",
        settings: {
          evmVersion: "cancun",
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    ]
  },
  networks: {
    hardhat: {
      forking: {
        url: process.env.HEDERA_TESTNET_RPC_URL || HEDERA_RPC_DEFAULTS.testnet,
        ...(process.env.HEDERA_FORK_BLOCK_NUMBER
          ? { blockNumber: Number.parseInt(process.env.HEDERA_FORK_BLOCK_NUMBER, 10) }
          : {}),
        // @ts-ignore Hedera forking plugin custom option.
        chainId: HEDERA_CHAIN_IDS.testnet,
        // @ts-ignore Hedera forking plugin custom option.
        workerPort: process.env.HEDERA_FORK_WORKER_PORT
          ? Number.parseInt(process.env.HEDERA_FORK_WORKER_PORT, 10)
          : 10001,
      },
    },
    hederaLocal: {
      url: process.env.HEDERA_LOCAL_RPC_URL || HEDERA_RPC_DEFAULTS.local,
      chainId: HEDERA_CHAIN_IDS.local,
      accounts,
    },
    hederaTestnet: {
      url: process.env.HEDERA_TESTNET_RPC_URL || HEDERA_RPC_DEFAULTS.testnet,
      chainId: HEDERA_CHAIN_IDS.testnet,
      accounts,
    },
    hederaPreviewnet: {
      url: process.env.HEDERA_PREVIEWNET_RPC_URL || HEDERA_RPC_DEFAULTS.previewnet,
      chainId: HEDERA_CHAIN_IDS.previewnet,
      accounts,
    },
    hederaMainnet: {
      url: process.env.HEDERA_MAINNET_RPC_URL || HEDERA_RPC_DEFAULTS.mainnet,
      chainId: HEDERA_CHAIN_IDS.mainnet,
      accounts,
    },
  },
};

export default config;
