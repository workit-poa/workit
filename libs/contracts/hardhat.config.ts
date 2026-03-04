import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

type HederaNetworkName = "hardhat" | "hederaLocal" | "hederaTestnet" | "hederaPreviewnet" | "hederaMainnet";

const HEDERA_RPC_DEFAULTS = {
  local: "http://127.0.0.1:7546",
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

const hederaPrivateKey = normalizePrivateKey(process.env.HEDERA_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY);
const accounts = hederaPrivateKey ? [hederaPrivateKey] : [];

const defaultNetworkMap: Record<string, HederaNetworkName> = {
  hardhat: "hardhat",
  local: "hederaLocal",
  localhost: "hederaLocal",
  testnet: "hederaTestnet",
  previewnet: "hederaPreviewnet",
  mainnet: "hederaMainnet",
};

const defaultNetwork = defaultNetworkMap[(process.env.HEDERA_NETWORK ?? "hardhat").toLowerCase()] ?? "hardhat";

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
