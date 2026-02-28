import { NextRequest, NextResponse } from "next/server";
import { assertWithinRateLimit, requestEmailOtpChallenge } from "@workit/auth";
import { assertSameOrigin, authErrorResponse, getSessionContext } from "../../_utils";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const ctx = getSessionContext(request);
    assertWithinRateLimit(`auth:otp:request:${ctx.ipAddress || "unknown"}`);

    const body = await request.json();
    const result = await requestEmailOtpChallenge(body, ctx);
    return NextResponse.json(
      {
        challengeId: result.challengeId,
        expiresAt: result.expiresAt.toISOString(),
        ...(result.debugCode ? { debugCode: result.debugCode } : {})
      },
      { status: 201 }
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
