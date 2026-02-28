import { index, integer, pgTable, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }),
    passwordHash: varchar("password_hash", { length: 255 }),
    googleId: varchar("google_id", { length: 255 }),
    facebookId: varchar("facebook_id", { length: 255 }),
    twitterId: varchar("twitter_id", { length: 255 }),
    discordId: varchar("discord_id", { length: 255 }),
    hederaAccountId: varchar("hedera_account_id", { length: 64 }),
    kmsKeyId: varchar("kms_key_id", { length: 255 }),
    hederaPublicKeyFingerprint: varchar("hedera_public_key_fingerprint", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull()
  },
  table => ({
    emailUnique: uniqueIndex("users_email_unique").on(table.email),
    googleUnique: uniqueIndex("users_google_id_unique").on(table.googleId),
    facebookUnique: uniqueIndex("users_facebook_id_unique").on(table.facebookId),
    twitterUnique: uniqueIndex("users_twitter_id_unique").on(table.twitterId),
    discordUnique: uniqueIndex("users_discord_id_unique").on(table.discordId)
  })
);

export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    replacedByTokenId: uuid("replaced_by_token_id"),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  table => ({
    tokenHashUnique: uniqueIndex("refresh_tokens_token_hash_unique").on(table.tokenHash),
    userIdx: index("refresh_tokens_user_id_idx").on(table.userId),
    expiresAtIdx: index("refresh_tokens_expires_at_idx").on(table.expiresAt)
  })
);

export const emailOtpChallenges = pgTable(
  "email_otp_challenges",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    codeHash: varchar("code_hash", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    ipAddress: varchar("ip_address", { length: 64 }),
    userAgent: varchar("user_agent", { length: 1024 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull()
  },
  table => ({
    emailIdx: index("email_otp_challenges_email_idx").on(table.email),
    expiresAtIdx: index("email_otp_challenges_expires_at_idx").on(table.expiresAt)
  })
);

export type UserRow = typeof users.$inferSelect;
export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type EmailOtpChallengeRow = typeof emailOtpChallenges.$inferSelect;
