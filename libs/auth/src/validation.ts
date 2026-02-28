import { z } from "zod";

const passwordPolicy = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password is too long")
  .regex(/[A-Z]/, "Password must include an uppercase letter")
  .regex(/[a-z]/, "Password must include a lowercase letter")
  .regex(/[0-9]/, "Password must include a number")
  .regex(/[^A-Za-z0-9]/, "Password must include a symbol");

const emailSchema = z.string().trim().email().transform(value => value.toLowerCase());

const registrationSchema = z.object({
  email: emailSchema,
  password: passwordPolicy
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1)
});

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

export type EmailRegistrationInput = z.input<typeof registrationSchema>;
export type EmailLoginInput = z.input<typeof loginSchema>;
export type OAuthCallbackInput = z.input<typeof oauthInputSchema>;
export type EmailOtpRequestInput = z.input<typeof emailOtpRequestSchema>;
export type EmailOtpVerifyInput = z.input<typeof emailOtpVerifySchema>;

export function validateEmailRegistrationInput(input: EmailRegistrationInput) {
  return registrationSchema.parse(input);
}

export function validateEmailLoginInput(input: EmailLoginInput) {
  return loginSchema.parse(input);
}

export function validateOAuthInput(input: OAuthCallbackInput) {
  return oauthInputSchema.parse(input);
}

export function validateEmailOtpRequestInput(input: EmailOtpRequestInput) {
  return emailOtpRequestSchema.parse(input);
}

export function validateEmailOtpVerifyInput(input: EmailOtpVerifyInput) {
  return emailOtpVerifySchema.parse(input);
}
