"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { CheckCircle2, Loader2, Mail, UserRound } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { sendEmailOtp, signInWithOAuth, verifyEmailOtp } from "../../lib/demo-auth";
import { useAuth } from "./auth-provider";

type OauthProvider = "google" | "x" | "discord";
type AuthRole = "participant" | "creator";

type AuthEntryPanelProps = {
  mode: "participant" | "creator";
};

export function AuthEntryPanel({ mode }: AuthEntryPanelProps) {
  const router = useRouter();
  const { setSession } = useAuth();

  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<OauthProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [demoCode, setDemoCode] = useState<string | null>(null);

  const heading = mode === "creator" ? "Create your creator workspace" : "Launch your Workit account";
  const subheading =
    mode === "creator"
      ? "Get into quest builder, budgets, and reward controls in one secure flow."
      : "Start completing quests with gasless, wallet-abstracted onboarding.";

  const role = useMemo<AuthRole>(() => (mode === "creator" ? "creator" : "participant"), [mode]);

  async function onSendCode() {
    setError(null);
    setNotice(null);
    setDemoCode(null);

    if (!email.trim()) {
      setError("Enter your email address first.");
      return;
    }

    setIsSending(true);
    try {
      const response = await sendEmailOtp(email);
      setChallengeId(response.challengeId);
      setDemoCode(response.demoCode);
      setNotice("Verification code sent. In this demo, use the code below.");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Could not send code.");
    } finally {
      setIsSending(false);
    }
  }

  async function onVerifyCode() {
    if (!challengeId) {
      setError("Request a verification code first.");
      return;
    }

    setError(null);
    setNotice(null);
    setIsVerifying(true);

    try {
      const session = await verifyEmailOtp({
        challengeId,
        email,
        code,
        role
      });

      setSession(session);
      router.push("/app");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "Code verification failed.");
    } finally {
      setIsVerifying(false);
    }
  }

  async function onOAuthSignIn(provider: OauthProvider) {
    setError(null);
    setNotice(null);
    setOauthLoading(provider);

    try {
      const session = await signInWithOAuth({ provider, role });
      setSession(session);
      router.push("/app");
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "OAuth sign-in failed.");
    } finally {
      setOauthLoading(null);
    }
  }

  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45, ease: "easeOut" }}>
      <Card className="w-full max-w-xl border-border/70 bg-card/92 shadow-2xl backdrop-blur">
        <CardHeader className="space-y-3">
          <p className="inline-flex w-fit items-center gap-2 rounded-full border border-border/70 bg-background/80 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <UserRound className="h-3.5 w-3.5" aria-hidden="true" />
            {mode === "creator" ? "Creator Mode" : "Participant Mode"}
          </p>
          <CardTitle className="text-2xl sm:text-3xl">{heading}</CardTitle>
          <CardDescription className="text-sm sm:text-base">{subheading}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-5">
          <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
            <p className="text-sm text-muted-foreground">
              No wallet needed. Workit creates a secure, abstracted wallet for you after sign-in.
            </p>
          </div>

        <section className="space-y-3" aria-label="Email OTP sign-in">
          <div className="space-y-2">
            <Label htmlFor="auth-email">Email</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="auth-email"
                type="email"
                value={email}
                placeholder="you@team.com"
                onChange={event => setEmail(event.target.value)}
                autoComplete="email"
              />
              <Button type="button" onClick={() => void onSendCode()} disabled={isSending} className="sm:min-w-36">
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Mail className="h-4 w-4" aria-hidden="true" />}
                <span className="ml-2">{isSending ? "Sending" : "Send Code"}</span>
              </Button>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="auth-code">Verification code</Label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="auth-code"
                type="text"
                value={code}
                placeholder="Enter 6-digit code"
                onChange={event => setCode(event.target.value)}
                inputMode="numeric"
              />
              <Button type="button" variant="secondary" onClick={() => void onVerifyCode()} disabled={isVerifying} className="sm:min-w-36">
                {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
                <span className="ml-2">{isVerifying ? "Verifying" : "Verify"}</span>
              </Button>
            </div>
          </div>

          {demoCode ? <p className="text-xs text-muted-foreground">Demo code: <span className="font-semibold text-foreground">{demoCode}</span></p> : null}
        </section>

        <div className="relative py-1">
          <div className="h-px bg-border" />
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            or continue with
          </span>
        </div>

        <motion.section
          className="grid gap-2 sm:grid-cols-3"
          aria-label="OAuth sign-in"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: {
              transition: {
                staggerChildren: 0.06
              }
            }
          }}
        >
          {([
            ["google", "Google"],
            ["x", "X"],
            ["discord", "Discord"]
          ] as const).map(([provider, label]) => (
            <motion.div
              key={provider}
              variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              whileHover={{ y: -1 }}
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => void onOAuthSignIn(provider)}
                disabled={oauthLoading !== null}
                className="w-full"
              >
                {oauthLoading === provider ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
                <span className={oauthLoading === provider ? "ml-2" : ""}>{label}</span>
              </Button>
            </motion.div>
          ))}
        </motion.section>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Authentication error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {notice ? (
          <Alert>
            <AlertTitle>Heads up</AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <p className="text-center text-xs text-muted-foreground">
          By continuing, you agree to Workit terms and security policies.
        </p>

        <div className="text-center text-sm text-muted-foreground">
          <Link href="/" className="focus-ring rounded-sm underline-offset-4 hover:underline">
            Back to landing page
          </Link>
        </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
