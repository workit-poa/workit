import { NextRequest, NextResponse } from "next/server";
import { assertWithinRateLimit, loginWithEmailPassword } from "@workit/auth";
import { assertSameOrigin, authErrorResponse, getSessionContext, setRefreshTokenCookie } from "../_utils";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const ctx = getSessionContext(request);
    assertWithinRateLimit(`auth:login:${ctx.ipAddress || "unknown"}`);

    const body = await request.json();
    const result = await loginWithEmailPassword(body, ctx);
    const response = NextResponse.json({
      user: result.user,
      accessToken: result.tokens.accessToken,
      accessTokenExpiresAt: result.tokens.accessTokenExpiresAt.toISOString()
    });

    setRefreshTokenCookie(response, result.tokens.refreshToken, result.tokens.refreshTokenExpiresAt);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
