import { createRemoteJWKSet, jwtVerify } from "jose";

export type OAuthProvider = "google" | "facebook" | "twitter";

export interface OAuthProfile {
  provider: OAuthProvider;
  providerUserId: string;
  email: string;
}

export interface OAuthVerificationInput {
  provider: OAuthProvider;
  idToken?: string;
  providerUserId?: string;
  email?: string;
}

const googleJwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

async function verifyGoogleIdToken(idToken: string): Promise<OAuthProfile> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error("GOOGLE_CLIENT_ID is required for Google OAuth");
  }

  const { payload } = await jwtVerify(idToken, googleJwks, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId
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

function assertTrustedProfileMode() {
  if (process.env.OAUTH_TRUSTED_PROFILE_MODE !== "true") {
    throw new Error("Provider requires trusted profile mode or server-side OAuth verification");
  }
}

function verifyTrustedProfile(provider: "facebook" | "twitter", input: OAuthVerificationInput): OAuthProfile {
  assertTrustedProfileMode();
  if (!input.providerUserId || !input.email) {
    throw new Error("providerUserId and email are required");
  }

  return {
    provider,
    providerUserId: input.providerUserId,
    email: input.email.toLowerCase()
  };
}

export async function verifyOAuthProfile(input: OAuthVerificationInput): Promise<OAuthProfile> {
  if (input.provider === "google") {
    if (!input.idToken) throw new Error("idToken is required for Google OAuth");
    return verifyGoogleIdToken(input.idToken);
  }

  if (input.provider === "facebook") {
    return verifyTrustedProfile("facebook", input);
  }

  return verifyTrustedProfile("twitter", input);
}

