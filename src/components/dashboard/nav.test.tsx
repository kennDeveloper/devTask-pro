import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Sidebar } from "./Sidebar";
import { NAV, isNavItemActive } from "./nav-config";
import { ShellProvider } from "./shell-context";
import { SidebarProvider } from "./sidebar-context";
import type { ShellUser } from "./types";

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

describe("nav config", () => {
  it("offers Today, Tasks, Overdue and Settings, in that order", () => {
    const labels = NAV.flatMap((group) =>
      group.items.map((item) => item.label),
    );
    expect(labels).toEqual(["Today", "Tasks", "Overdue", "Settings"]);
  });

  it("never marks an unbuilt destination active", () => {
    const tasks = NAV[0].items.find((item) => item.label === "Tasks")!;
    expect(isNavItemActive("/tasks", tasks)).toBe(false);
  });

  it("matches nested paths under a built destination", () => {
    const today = NAV[0].items.find((item) => item.label === "Today")!;
    expect(isNavItemActive("/today", today)).toBe(true);
    expect(isNavItemActive("/today/2026-08-06", today)).toBe(true);
    expect(isNavItemActive("/settings", today)).toBe(false);
  });
});

describe("<Sidebar>", () => {
  it("links the destinations that exist", () => {
    renderSidebar();

    expect(screen.getByRole("link", { name: "Today" })).toHaveAttribute(
      "href",
      "/today",
    );
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });

  /**
   * The point of the whole exercise: /tasks and /overdue do not exist until
   * phase 2, so they must be visible and inert. A link here would hand out a
   * 404; omitting them would hide where the product is going.
   */
  it.each(["Tasks", "Overdue"])(
    "renders %s as a disabled row, not a link",
    (label) => {
      renderSidebar();

      expect(screen.queryByRole("link", { name: new RegExp(label) })).toBeNull();

      const row = screen.getByText(label).closest("[aria-disabled='true']");
      expect(row).not.toBeNull();
      expect(row).toHaveTextContent("Soon");
    },
  );

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
