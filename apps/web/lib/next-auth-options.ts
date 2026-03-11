import type { NextAuthOptions } from "next-auth";
import type { OAuthConfig } from "next-auth/providers/oauth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import DiscordProvider from "next-auth/providers/discord";
import { authenticateWithOAuth, verifyEmailOtpChallenge } from "@workit-poa/auth";

type XOidcProfile = {
  sub: string;
  email?: string;
  name?: string;
};

function getEnv(name: string) {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value : null;
}

function maybeGoogleProvider() {
  const clientId = getEnv("GOOGLE_CLIENT_ID");
  const clientSecret = getEnv("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return GoogleProvider({ clientId, clientSecret });
}

function maybeDiscordProvider() {
  const clientId = getEnv("DISCORD_CLIENT_ID");
  const clientSecret = getEnv("DISCORD_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return DiscordProvider({ clientId, clientSecret });
}

function maybeXProvider() {
  const clientId = getEnv("X_CLIENT_ID");
  const clientSecret = getEnv("X_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return {
    ...xProvider,
    clientId,
    clientSecret
  } satisfies OAuthConfig<XOidcProfile>;
}

const xProvider: OAuthConfig<XOidcProfile> = {
  id: "x",
  name: "X",
  type: "oauth",
  wellKnown: "https://twitter.com/i/oauth2/.well-known/openid-configuration",
  authorization: {
    params: {
      scope: "openid users.read tweet.read offline.access email"
    }
  },
  clientId: "",
  clientSecret: "",
  checks: ["pkce", "state"],
  idToken: true,
  profile(profile: XOidcProfile) {
    return {
      id: profile.sub,
      email: profile.email ?? null,
      name: profile.name ?? null
    };
  }
};

function encodeErrorRedirect(message: string) {
  return `/auth?error=${encodeURIComponent(message)}`;
}

function resolveMirrorNodeBaseUrl(): string | null {
  const configured =
    process.env.HEDERA_MIRROR_NODE_URL?.trim() ||
    process.env.HEDERA_MIRROR_REST_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const network = (process.env.HEDERA_NETWORK || "testnet").trim().toLowerCase();
  if (network === "mainnet") return "https://mainnet-public.mirrornode.hedera.com";
  if (network === "testnet") return "https://testnet.mirrornode.hedera.com";
  if (network === "previewnet") return "https://previewnet.mirrornode.hedera.com";
  return null;
}

async function resolveEvmAddressFromMirror(hederaAccountId: string | null): Promise<string | null> {
  if (!hederaAccountId) return null;

  const mirrorBaseUrl = resolveMirrorNodeBaseUrl();
  if (!mirrorBaseUrl) return null;

  try {
    const response = await fetch(`${mirrorBaseUrl}/api/v1/accounts/${encodeURIComponent(hederaAccountId)}`, {
      headers: {
        accept: "application/json"
      },
      cache: "no-store"
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { evm_address?: unknown };
    return typeof payload.evm_address === "string" && payload.evm_address.trim().length > 0 ? payload.evm_address : null;
  } catch {
    return null;
  }
}

export const nextAuthOptions: NextAuthOptions = {
  pages: {
    signIn: "/auth"
  },
  session: {
    strategy: "jwt"
  },
  secret: process.env.NEXTAUTH_SECRET,
  providers: [
    CredentialsProvider({
      id: "otp",
      name: "Email OTP",
      credentials: {
        challengeId: { label: "Challenge ID", type: "text" },
        email: { label: "Email", type: "email" },
        code: { label: "Code", type: "text" }
      },
      async authorize(credentials) {
        if (!credentials?.challengeId || !credentials.email || !credentials.code) {
          throw new Error("Missing OTP credentials");
        }

        const result = await verifyEmailOtpChallenge({
          challengeId: credentials.challengeId,
          email: credentials.email,
          code: credentials.code
        }, {});

        return {
          id: result.user.id,
          email: result.user.email,
          name: result.user.email ?? "Workit User",
          hederaAccountId: result.user.hederaAccountId,
          createdAt: result.user.createdAt.toISOString()
        };
      }
    }),
    ...[maybeGoogleProvider(), maybeDiscordProvider(), maybeXProvider()].filter(Boolean)
  ] as NextAuthOptions["providers"],
  callbacks: {
    async signIn({ account, user }) {
      if (!account) return false;

      if (account.type === "credentials") return true;

      if (!user.email) {
        return encodeErrorRedirect("OAuth provider did not return an email address");
      }

      return true;
    },
    async jwt({ token, user, account }) {
      if (account?.type === "credentials" && user) {
        const hederaAccountId = (user as { hederaAccountId?: string | null }).hederaAccountId ?? null;
        token.workitUser = {
          id: user.id,
          email: user.email ?? null,
          hederaAccountId,
          evmAddress: await resolveEvmAddressFromMirror(hederaAccountId),
          createdAt: (user as { createdAt?: string }).createdAt ?? new Date().toISOString()
        };
        token.sub = user.id;
        return token;
      }

      if (account?.type === "oauth") {
        const provider =
          account.provider === "google" ? "google" : account.provider === "discord" ? "discord" : account.provider === "x" ? "x" : null;
        if (!provider) {
          throw new Error("Unsupported OAuth provider");
        }

        const providerUserId = account.providerAccountId;
        const email = user?.email;
        if (!providerUserId || !email) {
          throw new Error("Missing provider identity payload");
        }

        const result = await authenticateWithOAuth({ provider, providerUserId, email }, {});
        token.workitUser = {
          id: result.user.id,
          email: result.user.email,
          hederaAccountId: result.user.hederaAccountId,
          evmAddress: await resolveEvmAddressFromMirror(result.user.hederaAccountId),
          createdAt: result.user.createdAt.toISOString()
        };
        token.sub = result.user.id;
      }

      if (token.workitUser && token.workitUser.hederaAccountId && !token.workitUser.evmAddress) {
        token.workitUser.evmAddress = await resolveEvmAddressFromMirror(token.workitUser.hederaAccountId);
      }

      return token;
    },
    async session({ session, token }) {
      const workitUser = token.workitUser as
        | { id: string; email: string | null; hederaAccountId: string | null; evmAddress: string | null; createdAt: string }
        | undefined;
      if (!workitUser) {
        return session;
      }

      session.user = {
        ...session.user,
        id: workitUser.id,
        email: workitUser.email,
        hederaAccountId: workitUser.hederaAccountId,
        evmAddress: workitUser.evmAddress,
        createdAt: workitUser.createdAt
      };
      return session;
    }
  }
};
