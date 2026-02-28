import "./globals.css";

export const metadata = {
  title: "Workit",
  description: "Secure auth flow with Next.js, shadcn/ui, and Tailwind."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground">{children}</body>
    </html>
  );
}
