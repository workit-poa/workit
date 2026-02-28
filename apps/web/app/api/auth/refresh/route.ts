import { NextRequest, NextResponse } from "next/server";
import { assertWithinRateLimit, rotateRefreshToken } from "@workit/auth";
import {
  assertSameOrigin,
  authErrorResponse,
  getRefreshTokenFromCookie,
  getSessionContext,
  setRefreshTokenCookie
} from "../_utils";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const ctx = getSessionContext(request);
    assertWithinRateLimit(`auth:refresh:${ctx.ipAddress || "unknown"}`);

    const refreshToken = getRefreshTokenFromCookie(request);
    if (!refreshToken) {
      return NextResponse.json({ error: "Missing refresh token cookie" }, { status: 401 });
    }

    const nextSession = await rotateRefreshToken(refreshToken, ctx);
    const response = NextResponse.json({
      user: nextSession.user,
      accessToken: nextSession.accessToken,
      accessTokenExpiresAt: nextSession.accessTokenExpiresAt.toISOString()
    });

    setRefreshTokenCookie(response, nextSession.refreshToken, nextSession.refreshTokenExpiresAt);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
