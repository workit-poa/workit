import Link from "next/link";
import { buttonVariants } from "../components/ui/button";

export default function HomePage() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top_right,hsl(var(--secondary))_0%,transparent_42%),radial-gradient(circle_at_bottom_left,hsl(var(--accent))_0%,transparent_45%)] px-4">
      <section className="w-full max-w-xl rounded-2xl border border-border bg-card/85 p-8 shadow-lg backdrop-blur">
        <h1 className="text-4xl font-semibold tracking-tight">Proof of Activity</h1>
        <p className="mt-3 text-base text-muted-foreground">
          A unified fullstack app with secure JWT auth, refresh-token rotation, and protected API routes.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/login" className={buttonVariants()}>
            Go to login
          </Link>
          <Link href="/api/health" className={buttonVariants({ variant: "outline" })}>
            Health check
          </Link>
        </div>
      </section>
    </main>
  );
}
