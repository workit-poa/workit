import { NextResponse } from "next/server";
import { getWalletDetails } from "@workit/hedera-kms-wallet";

interface WalletRouteParams {
  params: Promise<{
    accountId: string;
  }>;
}

export async function GET(_request: Request, { params }: WalletRouteParams) {
  const { accountId } = await params;
  const network = process.env.HEDERA_NETWORK === "mainnet" ? "mainnet" : "testnet";
  const wallet = getWalletDetails(accountId, network);
  return NextResponse.json(wallet);
}
