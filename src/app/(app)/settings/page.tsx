import type { Metadata } from "next";

import { SettingsScreen } from "@/components/dashboard/settings-screen";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * A server shell around a client screen.
 *
 * The screen itself has to be a Client Component — it reads `profile.get`
 * through the tRPC React hooks, writes through `profile.update`, and drives
 * `next-themes` — but a `"use client"` page cannot export `metadata`. Keeping
 * the two apart is what lets the tab say "Settings · DevTask Pro".
 */
export default function SettingsPage() {
  return <SettingsScreen />;
}
