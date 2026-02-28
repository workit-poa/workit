import { WalletDetails } from "@workit/common";

export interface HederaClientConfig {
  network: "testnet" | "mainnet";
  operatorId?: string;
}

export function createHederaClient(config: HederaClientConfig) {
  return {
    network: config.network,
    getWallet(accountId: string): WalletDetails {
      return { accountId, network: config.network };
    }
  };
}

