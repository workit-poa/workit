import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "../../../../auth/_utils";
import { participateInCampaign } from "../../../../../../lib/launchpad/server";
import { requireSessionUser } from "../../../../../../lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to participate in campaign";
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ campaignAddress: string }> }
) {
  try {
    assertSameOrigin(request);
    const user = await requireSessionUser(request);
    const { campaignAddress } = await context.params;
    const body = (await request.json()) as { amount?: unknown };
    const amount = typeof body.amount === "string" ? body.amount : "";

    const result = await participateInCampaign({
      userId: user.id,
      campaignAddress,
      amount
    });

    return NextResponse.json(result);
  } catch (error) {
    return toErrorResponse(error);
  }
}
