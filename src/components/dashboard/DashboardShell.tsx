"use client";

import type { ReactNode } from "react";

import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { ShellProvider, type SignOutAction } from "./shell-context";
import { SidebarProvider } from "./sidebar-context";
import type { ShellUser } from "./types";

/**
 * The signed-in chrome: a fixed sidebar (w-60 from `md` up), a sticky topbar,
 * and a centred container for the route content.
 *
 * Two things the kickoff template does that this does not:
 *
 * 1. **No `TRPCProvider`.** The root layout already mounts one. Nesting a
 *    second would create a second QueryClient, so a mutation invalidating
 *    `profile.get` in one cache would leave the other serving stale data.
 *
 * 2. **No ⌘K command palette.** The template's palette searches the static nav
 *    and nothing else. With four destinations — two of them unbuilt — it would
 *    be a keyboard shortcut for reaching two links that are already on screen,
 *    and its "Search…" affordance would promise task search that phase 1 does
 *    not have. It also needs `@base-ui/react`, which is not a dependency here.
 *    `search-palette-context` and `sidebar-search-trigger` are dropped with it;
 *    they exist only to feed it.
 */
export function DashboardShell({
  user,
  signOut,
  children,
}: {
  user: ShellUser;
  signOut: SignOutAction;
  children: ReactNode;
}) {
  return (
    <ShellProvider user={user} signOut={signOut}>
      <SidebarProvider>
        <div data-app-shell="dashboard" className="min-h-screen bg-paper">
          <Sidebar />
          <div className="md:pl-60">
            <Topbar />
            <main>
              <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
                {children}
              </div>
            </main>
          </div>
        </div>
      </SidebarProvider>
    </ShellProvider>
  );
}
