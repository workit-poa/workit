import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";

async function verifyAuthHeader(request: NextRequest): Promise<boolean> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return false;

  const token = auth.slice("Bearer ".length).trim();
  if (!token) return false;

  const secret = process.env.AUTH_ACCESS_TOKEN_SECRET;
  if (!secret) return false;

  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: process.env.AUTH_JWT_ISSUER || "workit-auth",
      audience: process.env.AUTH_JWT_AUDIENCE || "workit-api"
    });
    return true;
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname.startsWith("/api/protected/")) {
    const ok = await verifyAuthHeader(request);
    if (!ok) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/protected/:path*"]
};

