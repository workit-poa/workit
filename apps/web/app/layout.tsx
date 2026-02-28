import type { Metadata } from "next";
import "./globals.css";
import { AuthProvider } from "../components/auth/auth-provider";

export const metadata: Metadata = {
  title: "Workit | Proof-of-Activity Quest Engine",
  description:
    "Workit is a Hedera-native Proof-of-Activity quest engine with gasless onboarding, AWS KMS-backed wallets, HCS-anchored receipts, and tradable Workit token rewards."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-background text-foreground font-workit antialiased">
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
