import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { SessionPayload } from "@workit-poa/common";
import { getDb } from "./db";
import { emailOtpChallenges, users, type UserRow } from "./schema";
import { provisionManagedWalletForUser } from "./wallet-provisioning";
import {
  EmailOtpRequestInput,
  EmailOtpVerifyInput,
  OAuthCallbackInput,
  validateEmailOtpRequestInput,
  validateEmailOtpVerifyInput,
  validateOAuthInput
} from "./validation";

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export interface AuthSessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface AuthUser {
  id: string;
  email: string | null;
  hederaAccountId: string | null;
  createdAt: Date;
}

export interface ManagedWalletSignerContext {
  userId: string;
  hederaAccountId: string;
  kmsKeyId: string;
}

function toAuthUser(user: UserRow): AuthUser {
  return {
    id: user.id,
    email: user.email,
    hederaAccountId: user.hederaAccountId,
    createdAt: user.createdAt
  };
}

function getLoginWelcomeBaseValue(email: string | null): string | undefined {
  if (!email) {
    return undefined;
  }

  const localPart = email.split("@")[0]?.trim();
  return localPart ? localPart : undefined;
}

async function createUserWithManagedWallet(
  values: Pick<UserRow, "email" | "googleId" | "facebookId" | "twitterId" | "discordId">
) {
  const db = getDb();
  const [createdUser] = await db.insert(users).values(values).returning();
  if (!createdUser) throw new Error("Failed to create account");

  try {
    const aliasUserId = getLoginWelcomeBaseValue(createdUser.email);
    const provisioned = await provisionManagedWalletForUser(createdUser.id, aliasUserId);

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
      googleId: null,
      facebookId: null,
      twitterId: null,
      discordId: null
    }));

  return { user: toAuthUser(user) };
}

export async function authenticateWithOAuth(input: OAuthCallbackInput, _ctx: AuthSessionContext) {
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
    return { user: toAuthUser(userByProvider) };
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
        googleId: parsed.provider === "google" ? parsed.providerUserId : null,
        facebookId: null,
        twitterId: parsed.provider === "x" ? parsed.providerUserId : null,
        discordId: parsed.provider === "discord" ? parsed.providerUserId : null
      });
  if (!linkedUser) throw new Error("Failed to link OAuth account");

  return { user: toAuthUser(linkedUser) };
}

export function createSessionPayload(userId: string): SessionPayload {
  return {
    userId,
    issuedAt: new Date().toISOString()
  };
}

export async function getManagedWalletSignerContext(userId: string): Promise<ManagedWalletSignerContext> {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    throw new Error("userId is required");
  }

  const db = getDb();
  const [user] = await db
    .select({
      id: users.id,
      hederaAccountId: users.hederaAccountId,
      kmsKeyId: users.kmsKeyId
    })
    .from(users)
    .where(eq(users.id, normalizedUserId))
    .limit(1);

  if (!user) {
    throw new Error("User not found");
  }
  if (!user.hederaAccountId || !user.kmsKeyId) {
    throw new Error("Managed wallet not provisioned for this user");
  }

  return {
    userId: user.id,
    hederaAccountId: user.hederaAccountId,
    kmsKeyId: user.kmsKeyId
  };
}
