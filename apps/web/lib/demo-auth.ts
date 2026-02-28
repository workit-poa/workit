export type AuthProvider = "email" | "google" | "x" | "discord";

export type WorkitSession = {
  userId: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  abstractedWalletId: string;
  role: "participant" | "creator";
  signedInAt: string;
};

type OtpChallenge = {
  challengeId: string;
  email: string;
  code: string;
  expiresAt: number;
};

const SESSION_STORAGE_KEY = "workit.demo.session";
const OTP_STORAGE_KEY = "workit.demo.otp";
const OTP_TTL_MS = 5 * 60 * 1000;

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function getChallenges(): OtpChallenge[] {
  if (!canUseStorage()) return [];

  const raw = window.localStorage.getItem(OTP_STORAGE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as OtpChallenge[];
    return parsed.filter(challenge => challenge.expiresAt > Date.now());
  } catch {
    return [];
  }
}

function saveChallenges(challenges: OtpChallenge[]) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(OTP_STORAGE_KEY, JSON.stringify(challenges));
}

function buildSession(email: string, provider: AuthProvider, role: WorkitSession["role"]): WorkitSession {
  const now = new Date();
  const local = email.split("@")[0] || "Workit User";
  return {
    userId: `wk_${Math.random().toString(36).slice(2, 10)}`,
    email,
    provider,
    role,
    displayName: local.replace(/[._-]/g, " ").replace(/\b\w/g, ch => ch.toUpperCase()),
    abstractedWalletId: `wallet_${Math.random().toString(36).slice(2, 10)}`,
    signedInAt: now.toISOString()
  };
}

export function readStoredSession(): WorkitSession | null {
  if (!canUseStorage()) return null;

  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as WorkitSession;
  } catch {
    return null;
  }
}

export function persistSession(session: WorkitSession | null) {
  if (!canUseStorage()) return;

  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export async function sendEmailOtp(email: string) {
  await wait(900);

  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("Enter a valid email address.");
  }

  const challenge: OtpChallenge = {
    challengeId: `otp_${Math.random().toString(36).slice(2, 10)}`,
    email: cleanEmail,
    code: `${Math.floor(100000 + Math.random() * 900000)}`,
    expiresAt: Date.now() + OTP_TTL_MS
  };

  const activeChallenges = getChallenges().filter(item => item.email !== cleanEmail);
  saveChallenges([...activeChallenges, challenge]);

  return {
    challengeId: challenge.challengeId,
    expiresAt: challenge.expiresAt,
    demoCode: challenge.code
  };
}

export async function verifyEmailOtp(input: {
  challengeId: string;
  email: string;
  code: string;
  role: WorkitSession["role"];
}) {
  await wait(1000);

  const targetEmail = input.email.trim().toLowerCase();
  const challenge = getChallenges().find(item => item.challengeId === input.challengeId && item.email === targetEmail);

  if (!challenge) {
    throw new Error("This code expired. Request a new one.");
  }

  if (challenge.code !== input.code.trim()) {
    throw new Error("That verification code is invalid.");
  }

  const session = buildSession(targetEmail, "email", input.role);
  persistSession(session);

  const remaining = getChallenges().filter(item => item.challengeId !== challenge.challengeId);
  saveChallenges(remaining);

  return session;
}

export async function signInWithOAuth(input: {
  provider: Exclude<AuthProvider, "email">;
  role: WorkitSession["role"];
}) {
  await wait(700);

  const fallbackDomains: Record<Exclude<AuthProvider, "email">, string> = {
    google: "gmail.com",
    x: "xmail.com",
    discord: "discordmail.com"
  };

  const token = Math.random().toString(36).slice(2, 8);
  const email = `${input.provider}_${token}@${fallbackDomains[input.provider]}`;
  const session = buildSession(email, input.provider, input.role);

  persistSession(session);
  return session;
}

export function clearSession() {
  persistSession(null);
}
