import { createRemoteJWKSet, jwtVerify } from "jose";
import crypto from "node:crypto";

export type OAuthProvider = "google" | "x" | "discord";

export interface OAuthProfile {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
}

interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string[];
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
let xJwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | null = null;

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getProviderConfig(provider: OAuthProvider): OAuthProviderConfig {
  if (provider === "google") {
    return {
      clientId: requiredEnv("GOOGLE_CLIENT_ID"),
      clientSecret: requiredEnv("GOOGLE_CLIENT_SECRET"),
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      scopes: ["openid", "email", "profile"]
    };
  }

  if (provider === "x") {
    return {
      clientId: requiredEnv("X_CLIENT_ID"),
      clientSecret: requiredEnv("X_CLIENT_SECRET"),
      authorizeUrl: "https://twitter.com/i/oauth2/authorize",
      tokenUrl: "https://api.twitter.com/2/oauth2/token",
      scopes: ["openid", "email", "users.read", "tweet.read"]
    };
  }

  return {
    clientId: requiredEnv("DISCORD_CLIENT_ID"),
    clientSecret: requiredEnv("DISCORD_CLIENT_SECRET"),
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    scopes: ["identify", "email"]
  };
}

export function getOAuthCallbackUrl(provider: OAuthProvider): string {
  const baseUrl = requiredEnv("AUTH_PUBLIC_BASE_URL").replace(/\/$/, "");
  return `${baseUrl}/api/auth/oauth/${provider}/callback`;
}

function randomBase64Url(byteLength: number) {
  return crypto.randomBytes(byteLength).toString("base64url");
}

export function newOAuthState() {
  return randomBase64Url(32);
}

export function newPkceCodeVerifier() {
  return randomBase64Url(48);
}

export function toPkceCodeChallenge(codeVerifier: string) {
  return crypto.createHash("sha256").update(codeVerifier).digest("base64url");
}

export function buildOAuthAuthorizationUrl(input: {
  provider: OAuthProvider;
  state: string;
  codeChallenge: string;
}) {
  const cfg = getProviderConfig(input.provider);
  const callbackUrl = getOAuthCallbackUrl(input.provider);
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }
  return url.toString();
}

interface OAuthTokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function exchangeOAuthCodeForTokens(input: {
  provider: OAuthProvider;
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokenResponse> {
  const cfg = getProviderConfig(input.provider);
  const callbackUrl = getOAuthCallbackUrl(input.provider);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: callbackUrl,
    client_id: cfg.clientId,
    code_verifier: input.codeVerifier
  });

  if (input.provider !== "x") {
    body.set("client_secret", cfg.clientSecret);
  }

  const tokenResponse = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(input.provider === "x"
        ? {
            Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64")}`
          }
        : {})
    },
    body
  });

  const payload = (await tokenResponse.json()) as OAuthTokenResponse;
  if (!tokenResponse.ok || payload.error) {
    throw new Error(payload.error_description || payload.error || "OAuth token exchange failed");
  }

  return payload;
}

async function verifyGoogleIdToken(idToken: string): Promise<OAuthProfile> {
  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: requiredEnv("GOOGLE_CLIENT_ID")
  });

  if (!payload.sub || typeof payload.sub !== "string" || !payload.email || typeof payload.email !== "string") {
    throw new Error("Invalid Google token payload");
  }

  return {
    provider: "google",
    providerUserId: payload.sub,
    email: payload.email.toLowerCase()
  };
}

async function verifyXIdToken(idToken: string): Promise<OAuthProfile> {
  if (!xJwksPromise) {
    xJwksPromise = (async () => {
      const discoveryResponse = await fetch("https://twitter.com/i/oauth2/.well-known/openid-configuration");
      if (!discoveryResponse.ok) {
        throw new Error("Could not load X OpenID configuration");
      }
      const discovery = (await discoveryResponse.json()) as { jwks_uri?: string };
      if (!discovery.jwks_uri) {
        throw new Error("X OpenID configuration missing jwks_uri");
      }
      return createRemoteJWKSet(new URL(discovery.jwks_uri));
    })();
  }

  const xJwks = await xJwksPromise;
  const { payload } = await jwtVerify(idToken, xJwks, {
    issuer: ["https://twitter.com", "twitter.com"],
    audience: requiredEnv("X_CLIENT_ID")
  });
  if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
    throw new Error("X OAuth did not return required user claims");
  }

  return {
    provider: "x",
    providerUserId: payload.sub,
    email: payload.email.toLowerCase()
  };
}

interface DiscordUserResponse {
  id?: string;
  email?: string;
}

async function fetchDiscordProfile(accessToken: string): Promise<OAuthProfile> {
  const response = await fetch("https://discord.com/api/users/@me", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const payload = (await response.json()) as DiscordUserResponse;
  if (!response.ok || !payload.id || !payload.email) {
    throw new Error("Discord OAuth did not return a valid profile");
  }

  return {
    provider: "discord",
    providerUserId: payload.id,
    email: payload.email.toLowerCase()
  };
}

export async function exchangeOAuthCodeForProfile(input: {
  provider: OAuthProvider;
  code: string;
  codeVerifier: string;
}): Promise<OAuthProfile> {
  const tokens = await exchangeOAuthCodeForTokens(input);
  if (input.provider === "google") {
    if (!tokens.id_token) throw new Error("Google OAuth response missing id_token");
    return verifyGoogleIdToken(tokens.id_token);
  }
  if (input.provider === "x") {
    if (!tokens.id_token) throw new Error("X OAuth response missing id_token");
    return verifyXIdToken(tokens.id_token);
  }
  if (!tokens.access_token) throw new Error("Discord OAuth response missing access token");
  return fetchDiscordProfile(tokens.access_token);
}
