import { NextResponse } from "next/server";
import { createWalletService } from "@workit/wallet";

const walletService = createWalletService();

interface WalletRouteParams {
  params: Promise<{
    accountId: string;
  }>;
}

export async function GET(_request: Request, { params }: WalletRouteParams) {
  const { accountId } = await params;
  const wallet = await walletService.getWalletDetails(accountId);
  return NextResponse.json(wallet);
}

