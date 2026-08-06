"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";

import { Logo, PROJECT_NAME } from "@/components/brand/logo";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { profileInitials } from "@/lib/profile-form";
import { cn } from "@/lib/utils";

import {
  COMING_SOON_HINT,
  COMING_SOON_LABEL,
  HOME_HREF,
  NAV,
  isNavItemActive,
} from "./nav-config";
import { useShell } from "./shell-context";
import { useSidebar } from "./sidebar-context";
import { SignOutButton } from "./sign-out-button";
import type { NavGroup, NavItem, ShellUser } from "./types";

/**
 * The fixed primary nav: a permanent rail from `md` up, an off-canvas drawer
 * below it. The template's ⌘K search trigger is not ported — see
 * `DashboardShell` for why.
 */
export function Sidebar() {
  const { mobileOpen, closeMobile } = useSidebar();
  const { user } = useShell();

  return (
    <>
      {/* Mobile scrim */}
      <div
        onClick={closeMobile}
        aria-hidden
        className={cn(
          "fixed inset-0 z-40 bg-ink/20 transition-opacity duration-200 md:hidden",
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        aria-label="Primary"
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-line bg-paper",
          "transition-transform duration-200 ease-out",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          "md:w-60 md:translate-x-0",
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 px-5">
          <Link
            href={HOME_HREF}
            onClick={closeMobile}
            className="inline-flex items-center"
            aria-label={`${PROJECT_NAME} home`}
          >
            <Logo size="md" variant="lockup" />
          </Link>
          <button
            type="button"
            onClick={closeMobile}
            aria-label="Close menu"
            className="inline-flex size-8 items-center justify-center rounded-md text-fg-3 transition-colors hover:bg-paper-2 hover:text-ink md:hidden"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-3 pt-2">
          {NAV.map((group, index) => (
            <NavGroupSection key={group.label ?? index} group={group} />
          ))}
        </nav>

        <UserCard user={user} />
      </aside>
    </>
  );
}

function NavGroupSection({ group }: { group: NavGroup }) {
  const pathname = usePathname();

  return (
    <div className="space-y-1">
      {group.label && (
        <Text variant="eyebrow" className="block px-3 pb-1 text-fg-4">
          {group.label}
        </Text>
      )}
      <ul className="space-y-1">
        {group.items.map((item) => (
          <li key={item.href}>
            {item.comingSoon ? (
              <UnbuiltNavRow item={item} />
            ) : (
              <NavLink item={item} active={isNavItemActive(pathname, item)} />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Shared geometry, so an unbuilt row sits on exactly the same grid as a link. */
const NAV_ROW =
  "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium";

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const { closeMobile } = useSidebar();
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      onClick={closeMobile}
      aria-current={active ? "page" : undefined}
      className={cn(
        NAV_ROW,
        "transition-colors",
        active
          ? "bg-accent-soft text-accent-deep"
          : "text-fg-2 hover:bg-paper-2 hover:text-ink",
      )}
    >
      <Icon
        className={cn(
          "size-[18px] shrink-0 transition-colors",
          active ? "text-accent-deep" : "text-fg-3 group-hover:text-ink",
        )}
        strokeWidth={1.75}
      />
      <span className="flex-1 truncate">{item.label}</span>
    </Link>
  );
}

/**
 * A destination that does not exist yet.
 *
 * A <span>, not a disabled <a>: there is no href to disable, and a link
 * element with no destination is a promise the router cannot keep.
 * `aria-disabled` tells assistive tech the same thing the muted colour tells
 * everyone else, and the visible "Soon" pill means nobody has to hover to find
 * out why the row does not respond.
 */
function UnbuiltNavRow({ item }: { item: NavItem }) {
  const Icon = item.icon;

  return (
    <span
      aria-disabled="true"
      title={COMING_SOON_HINT}
      className={cn(NAV_ROW, "cursor-not-allowed text-fg-4 select-none")}
    >
      <Icon className="size-[18px] shrink-0 text-fg-4" strokeWidth={1.75} />
      <span className="flex-1 truncate">{item.label}</span>
      <Badge tone="neutral" className="shrink-0">
        {COMING_SOON_LABEL}
      </Badge>
      <span className="sr-only">{COMING_SOON_HINT}</span>
    </span>
  );
}

function UserCard({ user }: { user: ShellUser }) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 border-t border-line px-4 py-3">
      <span
        aria-hidden
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent-deep"
      >
        {profileInitials(user.displayName, user.email)}
      </span>

      <span className="min-w-0 flex-1">
        <Text variant="body-sm" weight="semibold" truncate className="block" asChild>
          <span>{user.displayName}</span>
        </Text>
        <Text variant="caption" tone="muted" truncate className="block" asChild>
          <span>{user.email}</span>
        </Text>
      </span>

      {/* A two-item dropdown (Settings, which is already in the nav above, plus
          Sign out) is more machinery than it is worth. The one action that is
          not reachable from the nav gets the one button. */}
      <SignOutButton variant="ghost" iconOnly />
    </div>
  );
}
