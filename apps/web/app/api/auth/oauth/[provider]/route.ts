import { NextRequest, NextResponse } from "next/server";
import { assertWithinRateLimit, authenticateWithOAuth, verifyOAuthProfile } from "@workit/auth";
import { assertSameOrigin, authErrorResponse, getSessionContext, setRefreshTokenCookie } from "../../_utils";

interface RouteParams {
  params: Promise<{
    provider: string;
  }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    assertSameOrigin(request);
    const { provider } = await params;
    const ctx = getSessionContext(request);
    assertWithinRateLimit(`auth:oauth:${provider}:${ctx.ipAddress || "unknown"}`);
    if (!["google", "facebook", "twitter"].includes(provider)) {
      return NextResponse.json({ error: "Unsupported OAuth provider" }, { status: 400 });
    }

    const body = await request.json();
    const profile = await verifyOAuthProfile({
      provider: provider as "google" | "facebook" | "twitter",
      idToken: body?.idToken,
      providerUserId: body?.providerUserId,
      email: body?.email
    });

    const result = await authenticateWithOAuth(profile, ctx);
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
