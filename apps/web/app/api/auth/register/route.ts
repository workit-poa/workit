import { NextRequest, NextResponse } from "next/server";
import { assertWithinRateLimit, registerWithEmailPassword } from "@workit/auth";
import { assertSameOrigin, authErrorResponse, getSessionContext, setRefreshTokenCookie } from "../_utils";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const ctx = getSessionContext(request);
    assertWithinRateLimit(`auth:register:${ctx.ipAddress || "unknown"}`);

    const body = await request.json();
    const result = await registerWithEmailPassword(body, ctx);
    const response = NextResponse.json(
      {
        user: result.user,
        accessToken: result.tokens.accessToken,
        accessTokenExpiresAt: result.tokens.accessTokenExpiresAt.toISOString()
      },
      { status: 201 }
    );

    setRefreshTokenCookie(response, result.tokens.refreshToken, result.tokens.refreshTokenExpiresAt);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
