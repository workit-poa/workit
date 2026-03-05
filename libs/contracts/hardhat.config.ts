import { HardhatUserConfig, task } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import dotenv from "dotenv";

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

task("hedera:ping", "Ping JSON-RPC relay using eth_chainId and eth_blockNumber").setAction(async (_, hre) => {
  const [chainIdRaw, blockNumberRaw] = await Promise.all([
    hre.network.provider.request({
      method: "eth_chainId",
      params: [],
    }) as Promise<string>,
    hre.network.provider.request({
      method: "eth_blockNumber",
      params: [],
    }) as Promise<string>,
  ]);

  const chainId = Number.parseInt(chainIdRaw, 16);
  const blockNumber = Number.parseInt(blockNumberRaw, 16);

  console.log(`network=${hre.network.name}`);
  console.log(`eth_chainId=${chainIdRaw} (${Number.isNaN(chainId) ? "n/a" : chainId})`);
  console.log(`eth_blockNumber=${blockNumberRaw} (${Number.isNaN(blockNumber) ? "n/a" : blockNumber})`);
});

const config: HardhatUserConfig = {
  defaultNetwork,
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {},
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
