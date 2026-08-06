import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { INITIALS, PROJECT_NAME } from "@/components/brand/logo";
import { NAV } from "@/components/dashboard/nav-config";
import type { ShellUser } from "@/components/dashboard/types";

import { AdminShell } from "./admin-shell";
import { ADMIN_NAV } from "./admin-nav";

/**
 * The admin shell, and criterion 11.
 *
 * *"The admin shell carries no task navigation — no Today, Tasks, or Overdue
 * destination is reachable or rendered in an admin session."*
 *
 * The reachability half is `routeForStatus`'s (an admin outside /admin is sent
 * home) and is asserted in `src/lib/access/status-route.test.ts`. This file owns
 * the rendering half, and it asserts it against `NAV` itself rather than against
 * a hard-coded list of three hrefs — so a fourth task destination added in a
 * later phase is covered the day it is added, without anybody remembering to
 * come back here.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/users",
}));

afterEach(cleanup);

const USER: ShellUser = {
  displayName: "The Admin",
  email: "admin@example.com",
  roleLabel: "Administrator",
  statusLabel: "Active",
};

function renderShell() {
  return render(
    <AdminShell user={USER} signOut={vi.fn()}>
      <p>content</p>
    </AdminShell>,
  );
}

describe("criterion 11 — no task navigation", () => {
  it("renders no link to any destination in the member nav", () => {
    const { container } = renderShell();

    const memberHrefs = NAV.flatMap((group) =>
      group.items.map((item) => item.href),
    );
    expect(memberHrefs).toContain("/today");

    for (const href of memberHrefs) {
      expect(
        container.querySelector(`a[href="${href}"]`),
        `the admin shell links to ${href}`,
      ).toBeNull();
    }
  });

  it("renders no link outside the admin tier at all", () => {
    const { container } = renderShell();

    const hrefs = [...container.querySelectorAll("a[href]")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href?.startsWith("/admin")).toBe(true);
    }
  });

  it("mentions none of the task words anywhere in its chrome", () => {
    const { container } = renderShell();

    // The product is called "DevTask Pro", so the brand lockup legitimately
    // contains "task". Removing the product name rather than dropping "task"
    // from the list keeps the assertion meaningful — a stray "Tasks" nav label
    // would still fail.
    const text = (container.textContent ?? "")
      .toLowerCase()
      .replaceAll(PROJECT_NAME.toLowerCase(), "")
      .replaceAll(INITIALS.toLowerCase(), "");

    for (const word of ["today", "overdue", "task"]) {
      expect(text, `the admin shell says "${word}"`).not.toContain(word);
    }
  });
});

describe("what the shell does carry", () => {
  it("links the logo to the admin home, not the member one", () => {
    const { container } = renderShell();
    const logo = container.querySelector('a[aria-label*="admin home"]');

    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("href")).toBe("/admin/users");
  });

  it("renders every admin destination", () => {
    renderShell();

    for (const item of ADMIN_NAV) {
      // Two copies: the `sm`-and-up nav and the small-screen one below it.
      // jsdom applies no media queries, so both are visible to this query.
      expect(
        screen.getAllByRole("link", { name: item.label }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("marks the current destination", () => {
    renderShell();

    const current = screen.getAllByRole("link", { name: "Users" });
    expect(current.some((link) => link.getAttribute("aria-current") === "page")).toBe(
      true,
    );
  });

  /** Neither screen in this tier should be a dead end you leave by clearing cookies. */
  it("offers sign out", () => {
    renderShell();
    expect(screen.getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });

  it("names the tier, so an admin session is not mistakable for a member one", () => {
    renderShell();
    expect(screen.getByText("Admin")).toBeInTheDocument();
  });

  it("shows which account is acting", () => {
    renderShell();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });

  it("renders the page content", () => {
    renderShell();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  /**
   * The member shell's silhouette is a fixed sidebar. This one is a topbar, and
   * the difference is deliberate — an admin session should be recognisable at a
   * glance rather than looking like the member app with items missing.
   */
  it("is marked as its own shell, not the dashboard one", () => {
    const { container } = renderShell();

    expect(container.querySelector('[data-app-shell="admin"]')).not.toBeNull();
    expect(container.querySelector('[data-app-shell="dashboard"]')).toBeNull();
    expect(container.querySelector("aside")).toBeNull();
  });
});
