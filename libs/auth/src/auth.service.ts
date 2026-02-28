import crypto from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { SessionPayload } from "@workit/common";
import { getDb } from "./db";
import { getAuthConfig, msFromMinutes, msFromDays } from "./config";
import { hashPassword, verifyPassword } from "./password";
import { createAccessToken, hashRefreshToken, newRefreshTokenValue, verifyAccessToken } from "./token";
import { emailOtpChallenges, refreshTokens, users, type UserRow } from "./schema";
import { provisionManagedWalletForUser } from "./wallet-provisioning";
import {
  EmailLoginInput,
  EmailOtpRequestInput,
  EmailOtpVerifyInput,
  EmailRegistrationInput,
  OAuthCallbackInput,
  validateEmailLoginInput,
  validateEmailOtpRequestInput,
  validateEmailOtpVerifyInput,
  validateEmailRegistrationInput,
  validateOAuthInput
} from "./validation";

type OAuthProvider = "google" | "x" | "discord";
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export interface AuthSessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthUser {
  id: string;
  email: string | null;
  hederaAccountId: string | null;
  createdAt: Date;
}

function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    hederaAccountId: user.hederaAccountId,
    createdAt: user.createdAt
  };
}

async function issueTokensForUser(user: UserRow, ctx: AuthSessionContext): Promise<AuthTokens> {
  const db = getDb();
  const cfg = getAuthConfig();
  const accessTokenExpiresAt = new Date(Date.now() + msFromMinutes(cfg.accessTokenTtlMinutes));
  const refreshTokenExpiresAt = new Date(Date.now() + msFromDays(cfg.refreshTokenTtlDays));
  const refreshToken = newRefreshTokenValue();

  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshTokenExpiresAt,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent
  });

  return {
    accessToken: await createAccessToken(user),
    accessTokenExpiresAt,
    refreshToken,
    refreshTokenExpiresAt
  };
}

async function createUserWithManagedWallet(
  values: Pick<UserRow, "email" | "passwordHash" | "googleId" | "facebookId" | "twitterId" | "discordId">
) {
  const db = getDb();
  const [createdUser] = await db.insert(users).values(values).returning();
  if (!createdUser) throw new Error("Failed to create account");

  try {
    const provisioned = await provisionManagedWalletForUser(createdUser.id);

    const [updatedUser] = await db
      .update(users)
      .set({
        hederaAccountId: provisioned.hederaAccountId,
        kmsKeyId: provisioned.kmsKeyId,
        hederaPublicKeyFingerprint: provisioned.hederaPublicKeyFingerprint,
        updatedAt: new Date()
      })
      .where(eq(users.id, createdUser.id))
      .returning();

    return updatedUser;
  } catch (error) {
    await db.delete(users).where(eq(users.id, createdUser.id));
    throw error;
  }
}

function hashOtpCode(challengeId: string, code: string) {
  return crypto.createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

function generateOtpCode() {
  return `${crypto.randomInt(100000, 999999)}`;
}

async function dispatchOtpCode(email: string, code: string) {
  const webhookUrl = process.env.EMAIL_OTP_WEBHOOK_URL;
  if (!webhookUrl) {
    console.info(`[workit-auth] OTP for ${email}: ${code}`);
    return;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.EMAIL_OTP_WEBHOOK_BEARER
        ? { Authorization: `Bearer ${process.env.EMAIL_OTP_WEBHOOK_BEARER}` }
        : {})
    },
    body: JSON.stringify({
      to: email,
      code,
      ttlMinutes: Math.round(OTP_TTL_MS / 60_000)
    })
  });

  if (!response.ok) {
    throw new Error("Failed to send verification code");
  }
}

export async function requestEmailOtpChallenge(input: EmailOtpRequestInput, ctx: AuthSessionContext) {
  const db = getDb();
  const parsed = validateEmailOtpRequestInput(input);
  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);

  const [challenge] = await db
    .insert(emailOtpChallenges)
    .values({
      email: parsed.email,
      codeHash: "",
      expiresAt,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    })
    .returning({ id: emailOtpChallenges.id });

  if (!challenge) {
    throw new Error("Failed to create OTP challenge");
  }

  await db
    .update(emailOtpChallenges)
    .set({ codeHash: hashOtpCode(challenge.id, code) })
    .where(eq(emailOtpChallenges.id, challenge.id));

  await dispatchOtpCode(parsed.email, code);

  return {
    challengeId: challenge.id,
    expiresAt,
    ...(process.env.NODE_ENV !== "production" ? { debugCode: code } : {})
  };
}

export async function verifyEmailOtpChallenge(input: EmailOtpVerifyInput, ctx: AuthSessionContext) {
  const db = getDb();
  const parsed = validateEmailOtpVerifyInput(input);

  const [challenge] = await db
    .select()
    .from(emailOtpChallenges)
    .where(and(eq(emailOtpChallenges.id, parsed.challengeId), eq(emailOtpChallenges.email, parsed.email)))
    .limit(1);
  if (!challenge || challenge.consumedAt || challenge.expiresAt <= new Date()) {
    throw new Error("This verification code is invalid or expired");
  }
  if (challenge.attemptCount >= OTP_MAX_ATTEMPTS) {
    throw new Error("Too many invalid attempts");
  }

  const expectedHash = Buffer.from(challenge.codeHash, "hex");
  const actualHash = Buffer.from(hashOtpCode(challenge.id, parsed.code), "hex");
  const isValid =
    expectedHash.length === actualHash.length && crypto.timingSafeEqual(expectedHash, actualHash) && challenge.expiresAt > new Date();

  if (!isValid) {
    const attempts = challenge.attemptCount + 1;
    await db
      .update(emailOtpChallenges)
      .set({
        attemptCount: sql<number>`${emailOtpChallenges.attemptCount} + 1`,
        consumedAt: attempts >= OTP_MAX_ATTEMPTS ? new Date() : null
      })
      .where(eq(emailOtpChallenges.id, challenge.id));
    throw new Error("Invalid verification code");
  }

  await db
    .update(emailOtpChallenges)
    .set({
      consumedAt: new Date(),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent
    })
    .where(eq(emailOtpChallenges.id, challenge.id));

  const [existing] = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
  const user =
    existing ??
    (await createUserWithManagedWallet({
      email: parsed.email,
      passwordHash: null,
      googleId: null,
      facebookId: null,
      twitterId: null,
      discordId: null
    }));

  const tokens = await issueTokensForUser(user, ctx);
  return { user: toAuthUser(user), tokens };
}

export async function registerWithEmailPassword(input: EmailRegistrationInput, ctx: AuthSessionContext) {
  const db = getDb();
  const parsed = validateEmailRegistrationInput(input);
  const [existing] = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
  if (existing) {
    throw new Error("An account with this email already exists");
  }

  const user = await createUserWithManagedWallet({
    email: parsed.email,
    passwordHash: await hashPassword(parsed.password),
    googleId: null,
    facebookId: null,
    twitterId: null,
    discordId: null
  });

  const tokens = await issueTokensForUser(user, ctx);
  return { user: toAuthUser(user), tokens };
}

export async function loginWithEmailPassword(input: EmailLoginInput, ctx: AuthSessionContext) {
  const db = getDb();
  const parsed = validateEmailLoginInput(input);
  const [user] = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
  if (!user?.passwordHash) {
    throw new Error("Invalid email or password");
  }

  const valid = await verifyPassword(parsed.password, user.passwordHash);
  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const tokens = await issueTokensForUser(user, ctx);
  return { user: toAuthUser(user), tokens };
}

export async function authenticateWithOAuth(input: OAuthCallbackInput, ctx: AuthSessionContext) {
  const db = getDb();
  const parsed = validateOAuthInput(input);
  const email = parsed.email.toLowerCase();

  const [userByProvider] =
    parsed.provider === "google"
      ? await db.select().from(users).where(eq(users.googleId, parsed.providerUserId)).limit(1)
      : parsed.provider === "discord"
        ? await db.select().from(users).where(eq(users.discordId, parsed.providerUserId)).limit(1)
        : await db.select().from(users).where(eq(users.twitterId, parsed.providerUserId)).limit(1);

  if (userByProvider) {
    const tokens = await issueTokensForUser(userByProvider, ctx);
    return { user: toAuthUser(userByProvider), tokens };
  }

  const [userByEmail] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  const linkedUser = userByEmail
    ? (
        await db
          .update(users)
          .set({
            googleId: parsed.provider === "google" ? parsed.providerUserId : userByEmail.googleId,
            discordId: parsed.provider === "discord" ? parsed.providerUserId : userByEmail.discordId,
            twitterId: parsed.provider === "x" ? parsed.providerUserId : userByEmail.twitterId,
            updatedAt: new Date()
          })
          .where(eq(users.id, userByEmail.id))
          .returning()
      )[0]
    : await createUserWithManagedWallet({
        email,
        passwordHash: null,
        googleId: parsed.provider === "google" ? parsed.providerUserId : null,
        facebookId: null,
        twitterId: parsed.provider === "x" ? parsed.providerUserId : null,
        discordId: parsed.provider === "discord" ? parsed.providerUserId : null
      });
  if (!linkedUser) throw new Error("Failed to link OAuth account");

  const tokens = await issueTokensForUser(linkedUser, ctx);
  return { user: toAuthUser(linkedUser), tokens };
}

export async function rotateRefreshToken(refreshToken: string, ctx: AuthSessionContext): Promise<AuthTokens & { user: AuthUser }> {
  const db = getDb();
  const tokenHash = hashRefreshToken(refreshToken);
  const [current] = await db
    .select({
      token: refreshTokens,
      user: users
    })
    .from(refreshTokens)
    .innerJoin(users, eq(refreshTokens.userId, users.id))
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, new Date())))
    .limit(1);

  if (!current) {
    throw new Error("Invalid or expired refresh token");
  }

  const nextRefreshToken = newRefreshTokenValue();
  const nextRefreshExpires = new Date(Date.now() + msFromDays(getAuthConfig().refreshTokenTtlDays));

  const next = await db.transaction(async tx => {
    const [created] = await tx
      .insert(refreshTokens)
      .values({
        userId: current.token.userId,
        tokenHash: hashRefreshToken(nextRefreshToken),
        expiresAt: nextRefreshExpires,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent
      })
      .returning({ id: refreshTokens.id });
    if (!created) throw new Error("Failed to rotate refresh token");

    await tx
      .update(refreshTokens)
      .set({
        revokedAt: new Date(),
        replacedByTokenId: created.id
      })
      .where(eq(refreshTokens.id, current.token.id));

    return created;
  });

  const accessTokenExpiresAt = new Date(Date.now() + msFromMinutes(getAuthConfig().accessTokenTtlMinutes));

  return {
    user: toAuthUser(current.user),
    accessToken: await createAccessToken(current.user),
    accessTokenExpiresAt,
    refreshToken: nextRefreshToken,
    refreshTokenExpiresAt: nextRefreshExpires
  };
}

export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  const db = getDb();
  const tokenHash = hashRefreshToken(refreshToken);
  const [current] = await db
    .select({ id: refreshTokens.id })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), isNull(refreshTokens.revokedAt)))
    .limit(1);

  if (!current) return;

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.id, current.id));
}

export async function getAuthenticatedUserFromBearer(authorizationHeader: string | null) {
  const db = getDb();
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) return null;

  const payload = await verifyAccessToken(token);
  const [user] = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user) return null;
  return toAuthUser(user);
}

export function createSessionPayload(userId: string): SessionPayload {
  return {
    userId,
    issuedAt: new Date().toISOString()
  };
}
