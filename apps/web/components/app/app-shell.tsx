"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck, Wallet } from "lucide-react";
import { motion } from "framer-motion";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { useAuth } from "../auth/auth-provider";

export function AppShell() {
  const router = useRouter();
  const { session, hydrated, signOut } = useAuth();

  useEffect(() => {
    if (hydrated && !session) {
      router.replace("/auth");
    }
  }, [hydrated, session, router]);

  if (!hydrated || !session) {
    return (
      <main className="flex min-h-screen items-center justify-center px-4">
        <div className="inline-flex items-center gap-2 rounded-full border border-border/70 bg-card px-4 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Checking your session...
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10 sm:px-6">
      <motion.div
        className="mx-auto flex w-full max-w-4xl flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Workit app shell</p>
          <h1 className="text-3xl font-semibold tracking-tight">Welcome, {session.displayName}</h1>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => router.push("/")}>Landing</Button>
          <Button
            variant="destructive"
            onClick={() => {
              signOut();
              router.replace("/auth");
            }}
          >
            Sign out
          </Button>
        </div>
      </motion.div>

      <section className="mx-auto mt-8 grid w-full max-w-4xl gap-4 md:grid-cols-2">
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.06 }}>
          <Card className="border-border/70 bg-card/90">
            <CardHeader>
              <CardTitle className="text-lg">Identity</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p><span className="font-medium text-foreground">Email:</span> {session.email}</p>
              <p><span className="font-medium text-foreground">Provider:</span> {session.provider}</p>
              <p><span className="font-medium text-foreground">Role:</span> {session.role}</p>
              <p><span className="font-medium text-foreground">Signed in:</span> {new Date(session.signedInAt).toLocaleString()}</p>
            </CardContent>
          </Card>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.12 }}>
          <Card className="border-border/70 bg-card/90">
            <CardHeader>
              <CardTitle className="text-lg">Workit security context</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" /> HCS receipts + Workit token payouts via HTS</p>
              <p className="inline-flex items-center gap-2"><Wallet className="h-4 w-4 text-primary" aria-hidden="true" /> Abstracted wallet: {session.abstractedWalletId}</p>
              <p>KMS-backed wallet signing is orchestrated server-side for submissions, claims, and sponsored transactions.</p>
              <p>This is a minimal post-auth shell ready for quest feeds, creator tools, and proof history modules.</p>
              <Link href="/" className="text-foreground underline underline-offset-4">Return to marketing site</Link>
            </CardContent>
          </Card>
        </motion.div>
      </section>
    </main>
  );
}
