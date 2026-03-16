import { NextRequest, NextResponse } from "next/server";
import { getLaunchpadCampaigns } from "../../../../lib/launchpad/server";
import { requireSessionUser } from "../../../../lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to load launchpad campaigns";
  const status = message === "Unauthorized" ? 401 : 400;
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const user = await requireSessionUser(request);
    const campaigns = await getLaunchpadCampaigns({
      userHederaAccountId: user.hederaAccountId
    });
    return NextResponse.json({ campaigns });
  } catch (error) {
    return toErrorResponse(error);
  }
}
