import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { DashboardShell } from "./DashboardShell";
import type { ShellUser } from "./types";

const pathname = vi.hoisted(() => ({ current: "/today" }));

vi.mock("next/navigation", () => ({
  usePathname: () => pathname.current,
}));

afterEach(cleanup);

const USER: ShellUser = {
  displayName: "Ada Lovelace",
  email: "ada@example.com",
  roleLabel: "Member",
  statusLabel: "Active",
};

function renderShell(at = "/today") {
  pathname.current = at;
  return render(
    <DashboardShell user={USER} signOut={() => {}}>
      <p>Route content</p>
    </DashboardShell>,
  );
}

describe("<DashboardShell>", () => {
  it("renders the route content inside the main landmark", () => {
    renderShell();
    expect(
      within(screen.getByRole("main")).getByText("Route content"),
    ).toBeInTheDocument();
  });

  it("mounts the primary nav", () => {
    renderShell();
    const nav = screen.getByRole("complementary", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Today" })).toBeInTheDocument();
  });

  it("says where you are in the topbar", () => {
    renderShell("/settings");
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Settings");
  });

  it("puts a theme control in reach", () => {
    renderShell();
    const themes = screen.getByRole("group", { name: "Theme" });
    for (const label of ["System", "Light", "Dark"]) {
      expect(within(themes).getByRole("button", { name: label })).toBeEnabled();
    }
  });

  it("exposes the mobile drawer handle", () => {
    renderShell();
    expect(screen.getByRole("button", { name: "Open menu" })).toBeEnabled();
  });
});
