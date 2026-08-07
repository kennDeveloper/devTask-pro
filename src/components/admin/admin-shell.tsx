"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Logo, PROJECT_NAME } from "@/components/brand/logo";
import { ShellProvider, type SignOutAction } from "@/components/dashboard/shell-context";
import { SignOutButton } from "@/components/dashboard/sign-out-button";
import { isNavItemActive } from "@/components/dashboard/nav-config";
import type { ShellUser } from "@/components/dashboard/types";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import { ADMIN_HOME_HREF, ADMIN_NAV } from "./admin-nav";

/**
 * The admin tier's chrome — a topbar, and deliberately nothing else.
 *
 * ## Why this is not `DashboardShell`
 *
 * Decided with the user and recorded in `docs/gsd/phase-5-discuss.md`. The
 * member shell was built around task navigation: its sidebar's whole job is
 * linking to Today, Tasks and Overdue, which are three routes an admin session
 * must not reach (criterion 11). Reusing it would mean either rendering those
 * links to somebody who cannot follow them, or threading a role branch through a
 * component whose entire content is the thing being branched away — and the
 * separation that criterion 6 proves in the *database* is worth being able to
 * see in the UI.
 *
 * ## Why a topbar and no sidebar
 *
 * "Deliberately sparse" was the brief. With one destination, a 240px rail
 * holding one link is ceremony — and the different silhouette is what makes an
 * admin session recognisable at a glance rather than looking like the member app
 * with items missing. `ADMIN_NAV` is a list, so a second destination is a
 * one-line change and this becomes an ordinary nav.
 *
 * ## What it shares with the member shell, and why that is safe
 *
 * `ShellProvider` and `SignOutButton`, imported and not copied. Sign-out is a
 * Server Action defined in the layout, so the cookie is gone server-side before
 * the redirect renders — a client-side `signOut()` followed by `router.replace`
 * races the proxy. Sharing the *mechanism* costs nothing; what is not shared is
 * `NAV`, and that is the only part that would have carried task routes in.
 */
export function AdminShell({
  user,
  signOut,
  children,
}: {
  user: ShellUser;
  signOut: SignOutAction;
  children: ReactNode;
}) {
  const pathname = usePathname();

  return (
    <ShellProvider user={user} signOut={signOut}>
      <div data-app-shell="admin" className="min-h-screen bg-paper">
        <header className="sticky top-0 z-30 border-b border-line bg-paper">
          <div className="mx-auto flex w-full max-w-[1400px] items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
            <Link
              href={ADMIN_HOME_HREF}
              className="inline-flex shrink-0 items-center gap-2"
              aria-label={`${PROJECT_NAME} admin home`}
            >
              <Logo size="md" variant="lockup" />
            </Link>

            {/* Names the tier in the chrome itself. An admin and a member
                session must not be mistakable for one another at a glance —
                these two people are looking at different applications. */}
            <Badge tone="info" className="shrink-0">
              Admin
            </Badge>

            <nav aria-label="Admin" className="ml-2 hidden sm:block">
              <ul className="flex items-center gap-1">
                {ADMIN_NAV.map((item) => {
                  const active = isNavItemActive(pathname, item);
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                          active
                            ? "bg-accent-soft text-accent-deep"
                            : "text-fg-2 hover:bg-paper-2 hover:text-ink",
                        )}
                      >
                        <Icon
                          className="size-[18px] shrink-0"
                          strokeWidth={1.75}
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              {/* The identity, so an admin can tell which account they are
                  acting as — which matters more here than in the member app,
                  where everything on screen is already yours. */}
              <Text
                variant="caption"
                tone="muted"
                truncate
                className="hidden max-w-[16rem] md:block"
              >
                {user.email}
              </Text>
              <ThemeToggle />
              <SignOutButton variant="outline" size="sm" />
            </div>
          </div>

          {/* Below `sm` the nav moves under the identity row rather than being
              hidden behind a drawer. One destination does not earn a drawer, and
              a hamburger that opens a menu of one item is worse than the item. */}
          <nav
            aria-label="Admin"
            className="mx-auto w-full max-w-[1400px] px-4 pb-2 sm:hidden"
          >
            <ul className="flex items-center gap-1">
              {ADMIN_NAV.map((item) => {
                const active = isNavItemActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                        active
                          ? "bg-accent-soft text-accent-deep"
                          : "text-fg-2 hover:bg-paper-2 hover:text-ink",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </header>

        <main>
          <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
            {children}
          </div>
        </main>
      </div>
    </ShellProvider>
  );
}
