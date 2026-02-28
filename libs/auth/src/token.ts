import crypto from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getAuthConfig } from "./config";

interface AccessTokenPayload extends JWTPayload {
  sub: string;
  email?: string;
  type: "access";
}

function secretKey() {
  return new TextEncoder().encode(getAuthConfig().accessTokenSecret);
}

interface TokenUser {
  id: string;
  email: string | null;
}

export async function createAccessToken(user: TokenUser): Promise<string> {
  const cfg = getAuthConfig();
  const payload: AccessTokenPayload = {
    sub: user.id,
    email: user.email || undefined,
    type: "access"
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(cfg.jwtIssuer)
    .setAudience(cfg.jwtAudience)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${cfg.accessTokenTtlMinutes}m`)
    .sign(secretKey());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  const cfg = getAuthConfig();
  const { payload } = await jwtVerify(token, secretKey(), {
    issuer: cfg.jwtIssuer,
    audience: cfg.jwtAudience
  });

  if (payload.type !== "access" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token");
  }

  return payload as AccessTokenPayload;
}

export function newRefreshTokenValue(): string {
  return crypto.randomBytes(48).toString("base64url");
}

export function hashRefreshToken(refreshToken: string): string {
  return crypto.createHash("sha256").update(refreshToken).digest("hex");
}
