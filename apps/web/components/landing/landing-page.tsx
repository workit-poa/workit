import Link from "next/link";
import {
  ShieldCheck,
  Coins,
  Rocket,
  Blocks,
  KeyRound,
  CheckCircle2,
  ArrowRight,
  Cloud,
  BadgeCheck,
  Lock,
  Database
} from "lucide-react";
import { buttonVariants } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import { cn } from "../../lib/utils";
import { QuestCard } from "./quest-card";
import { ReceiptViewer } from "./receipt-viewer";

const navLinks = [
  { href: "#product", label: "Product" },
  { href: "#creators", label: "Creators" },
  { href: "#developers", label: "Developers" },
  { href: "#security", label: "Security" },
  { href: "#faq", label: "FAQ" }
];

const valueProps = [
  {
    icon: ShieldCheck,
    title: "Auditable Proof Trail (HCS)",
    body: "Every completion decision gets hashed and anchored to Hedera Consensus Service for tamper-evident replay."
  },
  {
    icon: Coins,
    title: "Instant Rewards (HTS points + NFT badges)",
    body: "Issue points and collectible badges through Hedera Token Service with creator-defined reward rules."
  },
  {
    icon: Rocket,
    title: "Gasless onboarding (no HBAR required)",
    body: "Relay and paymaster support removes token friction so users can complete quests from day one."
  },
  {
    icon: Blocks,
    title: "Platform-agnostic tasks (onchain + social)",
    body: "Mix wallet actions with YouTube, X, Discord, and off-chain proof tasks in one quest graph."
  },
  {
    icon: KeyRound,
    title: "Issuer-grade key security (AWS KMS + audit logs)",
    body: "Signing keys stay in KMS with CloudTrail records and key policy controls for enterprise-safe operations."
  }
];

const howItWorks = [
  "Creator publishes a quest, funds rewards, and funds gas sponsorship.",
  "Participant completes onchain and social tasks.",
  "Workit verifies evidence using APIs, Mirror Nodes, and custom verifiers.",
  "Completion receipt hash is anchored to HCS.",
  "Rewards are paid via HTS and proof links are shareable."
];

const participantBullets = ["Sign in with email or OAuth", "Complete tasks", "Earn points + badges", "Export and share proof receipts"];
const creatorBullets = [
  "Quest builder with reusable templates",
  "Budget controls for rewards and gas sponsorship",
  "Fraud and Sybil resistance gates",
  "CSV and JSON audit exports",
  "Custom reward logic for communities"
];

const faqs = [
  {
    question: "Do I need HBAR to use Workit?",
    answer: "No. Core interactions can be gas-sponsored through relay and paymaster flows."
  },
  {
    question: "What is anchored on-chain versus off-chain?",
    answer: "Evidence payloads can stay off-chain while decision hashes and receipt references are anchored on HCS."
  },
  {
    question: "How do social tasks work?",
    answer: "Creators define verifiers for platforms like X, YouTube, and Discord, then Workit validates submitted evidence."
  },
  {
    question: "What wallets are supported?",
    answer: "Workit creates an abstracted wallet after sign-in and can also link external wallets for advanced users."
  },
  {
    question: "How does Workit prevent bots?",
    answer: "It combines challenge checks, rate limits, proof validation rules, and optional Sybil-gating strategies."
  }
];

export function LandingPage() {
  return (
    <main className="relative overflow-x-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_20%_0%,hsl(var(--accent))_0%,transparent_35%),radial-gradient(circle_at_88%_20%,hsl(var(--secondary))_0%,transparent_32%),radial-gradient(circle_at_50%_100%,hsl(var(--muted))_0%,transparent_42%)]" />

      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground">
            Workit
          </Link>
          <nav className="hidden items-center gap-6 md:flex" aria-label="Primary">
            {navLinks.map(link => (
              <Link key={link.href} href={link.href} className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/auth?mode=creator" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "hidden sm:inline-flex")}>
              Create a Quest
            </Link>
            <Link href="/auth" className={buttonVariants({ size: "sm" })}>
              Launch App
            </Link>
          </div>
        </div>
      </header>

      <section id="product" className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-20 pt-16 sm:px-6 lg:grid-cols-[1.1fr,0.9fr] lg:pt-24">
        <div className="space-y-6 animate-fade-up">
          <p className="inline-flex rounded-full border border-border/80 bg-card/80 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Hedera Hello Future: Apex 2026
          </p>
          <h1 className="text-balance text-4xl font-semibold tracking-tight text-foreground sm:text-5xl lg:text-6xl">
            Proof-of-Activity quests, anchored on Hedera.
          </h1>
          <p className="max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Workit turns quests into auditable completion receipts with gasless UX, HCS-backed trust, and instant HTS points or NFT badge rewards.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/auth" className={buttonVariants({ size: "lg" })}>
              Launch App
            </Link>
            <Link href="#security" className={buttonVariants({ variant: "outline", size: "lg" })}>
              View Demo Proof
            </Link>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
            {[
              "HCS anchored",
              "HTS rewards",
              "AWS KMS signing",
              "Gasless via paymaster"
            ].map(item => (
              <span key={item} className="rounded-full border border-border/70 bg-card/70 px-3 py-1">
                {item}
              </span>
            ))}
          </div>
        </div>

        <Card className="self-start border-border/70 bg-card/80 shadow-xl animate-fade-up">
          <CardHeader>
            <CardTitle className="text-lg">Featured Quest Flow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {howItWorks.slice(0, 3).map((step, idx) => (
              <div key={step} className="flex gap-3 rounded-xl border border-border/70 bg-background/80 p-3">
                <span className="mt-0.5 inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {idx + 1}
                </span>
                <p className="text-sm text-muted-foreground">{step}</p>
              </div>
            ))}
            <Link href="/auth" className={cn(buttonVariants({ variant: "secondary" }), "w-full") }>
              Start a Quest
              <ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" />
            </Link>
          </CardContent>
        </Card>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 animate-fade-up">
          {valueProps.map(item => (
            <Card key={item.title} className="border-border/70 bg-card/85 transition-transform duration-300 hover:-translate-y-1 hover:shadow-lg">
              <CardHeader className="space-y-2">
                <item.icon className="h-5 w-5 text-primary" aria-hidden="true" />
                <CardTitle className="text-base leading-snug">{item.title}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{item.body}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section id="developers" className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight">How Workit Works</h2>
        <ol className="mt-8 grid gap-3 md:grid-cols-5">
          {howItWorks.map((step, idx) => (
            <li key={step} className="rounded-2xl border border-border/70 bg-card/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Step {idx + 1}</p>
              <p className="mt-2 text-sm text-muted-foreground">{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-20 sm:px-6 lg:grid-cols-[1fr,1.05fr]">
        <div className="space-y-5">
          <h2 className="text-3xl font-semibold tracking-tight">For Participants</h2>
          <ul className="space-y-3">
            {participantBullets.map(item => (
              <li key={item} className="flex items-start gap-2 text-muted-foreground">
                <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-3">
          <QuestCard title="Apex Builder Sprint: Ship + Share" points={350} chain="Hedera" difficulty="Medium" estimate="20 min" />
          <QuestCard title="DeFi Starter: First Swap + Proof" points={180} chain="EVM" difficulty="Easy" estimate="8 min" />
          <QuestCard title="Community Ops: Thread + Retention Loop" points={220} chain="Off-chain" difficulty="Medium" estimate="12 min" />
        </div>
      </section>

      <section id="creators" className="mx-auto grid w-full max-w-6xl gap-10 px-4 pb-20 sm:px-6 lg:grid-cols-[1.05fr,0.95fr]">
        <Card className="border-border/70 bg-card/90">
          <CardHeader>
            <CardTitle className="text-2xl">For Creators</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3">
              {creatorBullets.map(item => (
                <li key={item} className="flex items-start gap-2 text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <Link href="/auth?mode=creator" className={cn(buttonVariants({ size: "lg" }), "mt-6 w-full sm:w-auto") }>
              Create a Quest
            </Link>
          </CardContent>
        </Card>

        <div id="security" className="space-y-5">
          <h2 className="text-3xl font-semibold tracking-tight">Proof + Security</h2>
          <p className="text-muted-foreground">
            Completion receipts are hashed and anchored to HCS while raw evidence can stay off-chain. That keeps proofs replayable without leaking user artifacts.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Card className="border-border/70 bg-card/85">
              <CardContent className="space-y-2 p-4">
                <Lock className="h-5 w-5 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium">AWS KMS-managed signing</p>
              </CardContent>
            </Card>
            <Card className="border-border/70 bg-card/85">
              <CardContent className="space-y-2 p-4">
                <Cloud className="h-5 w-5 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium">CloudTrail audit logs</p>
              </CardContent>
            </Card>
            <Card className="border-border/70 bg-card/85 sm:col-span-2">
              <CardContent className="space-y-2 p-4">
                <Database className="h-5 w-5 text-primary" aria-hidden="true" />
                <p className="text-sm font-medium">Key policy controls with issuer/operator boundaries</p>
              </CardContent>
            </Card>
          </div>
          <ReceiptViewer />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <div className="rounded-3xl border border-border/70 bg-card/80 p-6 sm:p-8">
          <p className="text-sm font-medium text-muted-foreground">Built for Hedera Hello Future: Apex 2026</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {[
              "Open-source",
              "Hedera-native",
              "AWS bounty aligned"
            ].map(item => (
              <span key={item} className="inline-flex items-center gap-1 rounded-full border border-border/80 px-3 py-1 text-xs font-medium text-muted-foreground">
                <BadgeCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                {item}
              </span>
            ))}
          </div>
          <ul className="mt-5 grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
            <li>Roadmap: creator governance controls</li>
            <li>Roadmap: quest staking incentives</li>
            <li>Roadmap: richer verifier marketplace</li>
          </ul>
        </div>
      </section>

      <section id="faq" className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
        <h2 className="text-3xl font-semibold tracking-tight">FAQ</h2>
        <div className="mt-6 space-y-3">
          {faqs.map(item => (
            <details key={item.question} className="group rounded-xl border border-border/70 bg-card/85 p-4 open:shadow-sm">
              <summary className="cursor-pointer list-none text-sm font-medium text-foreground">{item.question}</summary>
              <p className="mt-2 text-sm text-muted-foreground">{item.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className="border-t border-border/70 bg-card/65">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 sm:flex-row sm:items-center sm:px-6">
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <Link href="#" className="hover:text-foreground">Docs</Link>
            <Link href="#" className="hover:text-foreground">GitHub</Link>
            <Link href="#" className="hover:text-foreground">Terms</Link>
            <Link href="#" className="hover:text-foreground">Privacy</Link>
          </div>
          <Link href="/auth" className={buttonVariants()}>
            Launch App
          </Link>
        </div>
      </footer>
    </main>
  );
}
