import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "../../auth/_utils";
import { claimDailyUsdcFaucet, getUsdcFaucetStatus } from "../../../../lib/faucet/server";
import { requireSessionUser } from "../../../../lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "USDC faucet request failed";
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireSessionUser(request);
    const status = await getUsdcFaucetStatus(user.id);
    return NextResponse.json({
      eligible: status.eligible,
      retryAfterSeconds: status.retryAfterSeconds,
      nextEligibleAt: status.nextEligibleAt ? status.nextEligibleAt.toISOString() : null
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser(request);
    const result = await claimDailyUsdcFaucet(user.id);

    if (result.status === "rate_limited") {
      return NextResponse.json(
        {
          status: result.status,
          retryAfterSeconds: result.retryAfterSeconds,
          nextEligibleAt: result.nextEligibleAt.toISOString()
        },
        { status: 429 }
      );
    }

    return NextResponse.json({
      status: result.status,
      tokenSymbol: result.tokenSymbol,
      amount: result.amount,
      recipient: result.recipient,
      transactionHash: result.transactionHash,
      explorerUrl: result.explorerUrl,
      nextEligibleAt: result.nextEligibleAt.toISOString()
    });
  } catch (error) {
    return errorResponse(error);
  }
}
