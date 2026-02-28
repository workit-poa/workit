import { z } from "zod";

const emailSchema = z.string().trim().email().transform(value => value.toLowerCase());

const oauthInputSchema = z.object({
  provider: z.enum(["google", "x", "discord"]),
  providerUserId: z.string().min(2),
  email: emailSchema
});

const emailOtpRequestSchema = z.object({
  email: emailSchema
});

const emailOtpVerifySchema = z.object({
  challengeId: z.string().uuid("Invalid challenge ID"),
  email: emailSchema,
  code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits")
});

export type OAuthCallbackInput = z.input<typeof oauthInputSchema>;
export type EmailOtpRequestInput = z.input<typeof emailOtpRequestSchema>;
export type EmailOtpVerifyInput = z.input<typeof emailOtpVerifySchema>;

export function validateOAuthInput(input: OAuthCallbackInput) {
  return oauthInputSchema.parse(input);
}

export function validateEmailOtpRequestInput(input: EmailOtpRequestInput) {
  return emailOtpRequestSchema.parse(input);
}

export function validateEmailOtpVerifyInput(input: EmailOtpVerifyInput) {
  return emailOtpVerifySchema.parse(input);
}
