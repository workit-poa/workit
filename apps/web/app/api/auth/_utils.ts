import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@workit/auth";

export function getSessionContext(request: NextRequest) {
  return {
    ipAddress: getClientIp(request.headers),
    userAgent: request.headers.get("user-agent") || undefined
  };
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
