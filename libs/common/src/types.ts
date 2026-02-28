export interface SessionPayload {
  userId: string;
  issuedAt: string;
}

export interface WalletDetails {
  accountId: string;
  network: "testnet" | "mainnet";
  evmAddress?: string;
}

