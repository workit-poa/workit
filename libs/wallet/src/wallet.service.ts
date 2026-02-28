import { WalletDetails } from "@workit/common";
import { createHederaClient } from "@workit/hedera";

export function createWalletService() {
  const client = createHederaClient({ network: "testnet" });

  return {
    async getWalletDetails(accountId: string): Promise<WalletDetails> {
      return client.getWallet(accountId);
    }
  };
}

