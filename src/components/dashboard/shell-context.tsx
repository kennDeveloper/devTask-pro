"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

import type { ShellUser } from "./types";

/**
 * A Server Action, as seen from the client. It is defined once in
 * `src/app/(app)/layout.tsx` — same shape as the one `(gate)/layout.tsx`
 * already uses — and handed down here so the sidebar and the settings screen
 * sign out through one implementation rather than two copies of
 * `supabase.auth.signOut()` that can drift apart.
 */
export type SignOutAction = () => void | Promise<void>;

export type ShellValue = {
  user: ShellUser;
  signOut: SignOutAction;
};

const ShellContext = createContext<ShellValue | null>(null);

export function ShellProvider({
  user,
  signOut,
  children,
}: ShellValue & { children: ReactNode }) {
  // The value is an object literal; without the memo every consumer re-renders
  // whenever the shell does.
  const value = useMemo(() => ({ user, signOut }), [user, signOut]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

export function useShell() {
  const context = useContext(ShellContext);
  if (!context) {
    throw new Error("useShell must be used inside <ShellProvider>");
  }
  return context;
}
