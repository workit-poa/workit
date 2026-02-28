import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@workit/auth";

const REFRESH_COOKIE_NAME = "workit_refresh_token";

export function getSessionContext(request: NextRequest) {
  return {
    ipAddress: getClientIp(request.headers),
    userAgent: request.headers.get("user-agent") || undefined
  };
}

export function setRefreshTokenCookie(response: NextResponse, refreshToken: string, expiresAt: Date) {
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: expiresAt,
    path: "/api/auth"
  });
}

export function clearRefreshTokenCookie(response: NextResponse) {
  response.cookies.set({
    name: REFRESH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    expires: new Date(0),
    path: "/api/auth"
  });
}

export function getRefreshTokenFromCookie(request: NextRequest): string | null {
  return request.cookies.get(REFRESH_COOKIE_NAME)?.value || null;
}

export function authErrorResponse(error: unknown, fallbackStatus = 400) {
  const message = error instanceof Error ? error.message : "Authentication error";
  const status = message.includes("Invalid") || message.includes("expired") ? 401 : fallbackStatus;
  return NextResponse.json({ error: message }, { status });
}

export function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (!origin) return;

  const originHost = new URL(origin).host;
  if (originHost !== request.nextUrl.host) {
    throw new Error("CSRF validation failed");
  }
}
