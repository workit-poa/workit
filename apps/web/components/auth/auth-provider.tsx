"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { clearSession, persistSession, readStoredSession, type WorkitSession } from "../../lib/demo-auth";

type AuthContextValue = {
  session: WorkitSession | null;
  hydrated: boolean;
  setSession: (session: WorkitSession | null) => void;
  signOut: () => void;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSessionState] = useState<WorkitSession | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setSessionState(readStoredSession());
    setHydrated(true);
  }, []);

  const setSession = useCallback((nextSession: WorkitSession | null) => {
    persistSession(nextSession);
    setSessionState(nextSession);
  }, []);

  const signOut = useCallback(() => {
    clearSession();
    setSessionState(null);
  }, []);

  const value = useMemo(
    () => ({
      session,
      hydrated,
      setSession,
      signOut
    }),
    [session, hydrated, setSession, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider.");
  }

  return context;
}
