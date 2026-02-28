import { NextRequest, NextResponse } from "next/server";
import { revokeRefreshToken } from "@workit/auth";
import { assertSameOrigin, authErrorResponse, clearRefreshTokenCookie, getRefreshTokenFromCookie } from "../_utils";

export async function POST(request: NextRequest) {
  try {
    assertSameOrigin(request);
    const refreshToken = getRefreshTokenFromCookie(request);
    if (refreshToken) {
      await revokeRefreshToken(refreshToken);
    }

    const response = NextResponse.json({ ok: true });
    clearRefreshTokenCookie(response);
    return response;
  } catch (error) {
    return authErrorResponse(error);
  }
}
