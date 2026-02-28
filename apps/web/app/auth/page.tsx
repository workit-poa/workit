import Link from "next/link";
import { AuthEntryPanel } from "../../components/auth/auth-entry-panel";

type AuthPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AuthPage({ searchParams }: AuthPageProps) {
  const params = await searchParams;
  const rawMode = params?.mode;
  const mode = (Array.isArray(rawMode) ? rawMode[0] : rawMode) === "creator" ? "creator" : "participant";

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_top_left,hsl(var(--accent))_0%,transparent_40%),radial-gradient(circle_at_bottom_right,hsl(var(--secondary))_0%,transparent_45%)] px-4 py-10">
      <div className="absolute left-4 top-4">
        <Link className="focus-ring rounded-md px-2 py-1 text-sm text-muted-foreground underline-offset-4 hover:underline" href="/">
          Back home
        </Link>
      </div>
      <AuthEntryPanel mode={mode} />
    </main>
  );
}
