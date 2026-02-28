"use client";

import { createContext, useContext, useMemo } from "react";
import { SessionProvider, signOut as nextAuthSignOut, useSession } from "next-auth/react";

export type AuthUser = {
  id: string;
  email: string | null;
  hederaAccountId: string | null;
  createdAt: string;
};

export type AuthSession = {
  user: AuthUser;
};

type AuthContextValue = {
  session: AuthSession | null;
  isAuthenticated: boolean;
  hydrated: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function AuthProviderInner({ children }: { children: React.ReactNode }) {
  const { data, status } = useSession();
  const hydrated = status !== "loading";
  const session = data?.user?.id
    ? ({
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          hederaAccountId: data.user.hederaAccountId ?? null,
          createdAt: data.user.createdAt
        }
      } satisfies AuthSession)
    : null;

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      isAuthenticated: Boolean(session),
      hydrated,
      signOut: async () => {
        await nextAuthSignOut({ redirect: false });
      }
    }),
    [session, hydrated]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <AuthProviderInner>{children}</AuthProviderInner>
    </SessionProvider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }
  return context;
}
