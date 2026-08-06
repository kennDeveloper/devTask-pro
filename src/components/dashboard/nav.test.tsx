import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ShieldCheck } from "lucide-react";

import { Sidebar } from "./Sidebar";
import { NAV, isNavItemActive } from "./nav-config";
import { ShellProvider } from "./shell-context";
import { SidebarProvider } from "./sidebar-context";
import type { NavItem, ShellUser } from "./types";

// The sidebar and the breadcrumbs both ask where they are. There is no App
// Router in a jsdom render, so the hook is stubbed rather than the whole
// component tree wrapped.
const pathname = vi.hoisted(() => ({ current: "/today" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

// vitest.config.ts does not enable `globals`, so RTL's auto-cleanup never
// registers itself. Unmount explicitly or renders stack in one document.
afterEach(cleanup);

const USER: ShellUser = {
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  roleLabel: "Member",
  statusLabel: "Active",
};

function renderSidebar(at = "/today") {
  pathname.current = at;
  return render(
    <ShellProvider user={USER} signOut={() => {}}>
      <SidebarProvider>
        <Sidebar />
      </SidebarProvider>
    </ShellProvider>,
  );
}

/** Not in `NAV` — nothing is `comingSoon` any more. See the test that uses it. */
const UNBUILT: NavItem = {
  href: "/admin",
  label: "Admin",
  icon: ShieldCheck,
  comingSoon: true,
};

describe("nav config", () => {
  it("offers Today, Tasks, Overdue and Settings, in that order", () => {
    const labels = NAV.flatMap((group) =>
      group.items.map((item) => item.label),
    );
    expect(labels).toEqual(["Today", "Tasks", "Overdue", "Settings"]);
  });

  /**
   * The inverse of what this file asserted through phase 1. Both routes now
   * exist, so the `comingSoon` flag is off and they highlight like any other
   * destination — which is the observable consequence of the flag, and the part
   * that would silently regress if someone put it back.
   */
  it.each([
    ["Tasks", "/tasks"],
    ["Overdue", "/overdue"],
  ])("marks %s active now that it is a real route", (label, path) => {
    const item = NAV[0].items.find((entry) => entry.label === label)!;
    expect(item.comingSoon).toBeUndefined();
    expect(isNavItemActive(path, item)).toBe(true);
  });

  /**
   * Asserted against a synthetic item because no *real* one is unbuilt today.
   * The rule is kept — and kept covered — for the next destination that lands
   * in the nav before it lands on disk (phase 5's admin tier is the candidate).
   */
  it("never marks an unbuilt destination active", () => {
    expect(isNavItemActive("/admin", UNBUILT)).toBe(false);
  });

  it("matches nested paths under a built destination", () => {
    const today = NAV[0].items.find((item) => item.label === "Today")!;
    expect(isNavItemActive("/today", today)).toBe(true);
    expect(isNavItemActive("/today/2026-08-06", today)).toBe(true);
    expect(isNavItemActive("/settings", today)).toBe(false);
  });
});

/** Every destination, flattened — the table both Sidebar link tests run over. */
const DESTINATIONS = NAV.flatMap((group) => group.items).map(
  (item) => [item.label, item.href] as const,
);

describe("<Sidebar>", () => {
  it.each(DESTINATIONS)("links %s to %s", (label, href) => {
    renderSidebar();

    expect(screen.getByRole("link", { name: label })).toHaveAttribute(
      "href",
      href,
    );
  });

  /**
   * The counterpart to the phase-1 test that required /tasks and /overdue to be
   * inert. Every destination is now a real route, so an `aria-disabled` row
   * anywhere in the nav means a flag was left on and a page is unreachable from
   * the sidebar that ships to link to it.
   */
  it("leaves no inert rows behind", () => {
    const { container } = renderSidebar();

    expect(container.querySelector("[aria-disabled='true']")).toBeNull();
    expect(screen.queryByText("Soon")).toBeNull();
  });

  it("marks the current route with aria-current", () => {
    renderSidebar("/settings");

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("link", { name: "Today" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("shows who is signed in, and a way out", () => {
    renderSidebar();

    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("ada@example.com")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });
});
