import { expect, test } from "@playwright/test";

import {
  TEST_PASSWORD,
  createAccount,
  deleteAccount,
  uniqueEmail,
} from "./helpers/accounts";

/**
 * Screenshots every route, in both themes, at whatever viewport the running project
 * defines (chromium desktop and iPhone 14 — see playwright.config.ts).
 *
 * This is proof-of-render, not visual regression: no baseline is committed, so it
 * fails on an error or a console error rather than on a pixel diff. Its real purpose
 * is producing artefacts a human can look at — the dark palette in particular was
 * built to a numeric contrast spec and needs eyes on it.
 */

const PUBLIC_ROUTES = [
  { path: "/", name: "marketing" },
  { path: "/sign-in", name: "sign-in" },
  { path: "/sign-up", name: "sign-up" },
  { path: "/forgot-password", name: "forgot-password" },
  { path: "/reset-password", name: "reset-password" },
];

const SIGNED_IN_ROUTES = [
  { path: "/today", name: "today" },
  { path: "/settings", name: "settings" },
];

/** Force a next-themes choice before paint, so the shot isn't of the system default. */
async function useTheme(page: import("@playwright/test").Page, theme: "light" | "dark") {
  await page.addInitScript((t) => {
    window.localStorage.setItem("theme", t);
  }, theme);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test(`public routes render`, async ({ page }, testInfo) => {
      const consoleErrors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });

      await useTheme(page, theme);

      for (const route of PUBLIC_ROUTES) {
        const response = await page.goto(route.path);
        expect(
          response?.status(),
          `${route.path} should not error`,
        ).toBeLessThan(400);

        await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: testInfo.outputPath(
            `${testInfo.project.name}-${theme}-${route.name}.png`,
          ),
          fullPage: true,
        });
      }

      expect(consoleErrors, "no console errors while rendering").toEqual([]);
    });

    test(`gate screens render`, async ({ page }, testInfo) => {
      await useTheme(page, theme);

      const pending = uniqueEmail("shot-pending");
      const suspended = uniqueEmail("shot-suspended");
      await createAccount(pending, "pending");
      await createAccount(suspended, "suspended");

      for (const [email, name, url] of [
        [pending, "pending", /\/pending/],
        [suspended, "no-access", /\/no-access/],
      ] as const) {
        await page.goto("/sign-in");
        await page.getByLabel(/^email$/i).fill(email);
        await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
        await page.getByRole("button", { name: /sign in/i }).click();
        await page.waitForURL(url);

        await page.screenshot({
          path: testInfo.outputPath(
            `${testInfo.project.name}-${theme}-${name}.png`,
          ),
          fullPage: true,
        });
      }

      await deleteAccount(pending);
      await deleteAccount(suspended);
    });

    test(`signed-in routes render`, async ({ page }, testInfo) => {
      await useTheme(page, theme);

      const email = uniqueEmail("shot-active");
      await createAccount(email, "active");

      await page.goto("/sign-in");
      await page.getByLabel(/^email$/i).fill(email);
      await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL(/\/today/);

      for (const route of SIGNED_IN_ROUTES) {
        await page.goto(route.path);
        await page.waitForLoadState("networkidle");
        await page.screenshot({
          path: testInfo.outputPath(
            `${testInfo.project.name}-${theme}-${route.name}.png`,
          ),
          fullPage: true,
        });
      }

      await deleteAccount(email);
    });
  });
}

test("no page scrolls horizontally", async ({ page }) => {
  // The repo rule is that wide content scrolls inside its own container, never the
  // body. Cheapest possible regression guard, and it catches most layout blowouts.
  for (const route of PUBLIC_ROUTES) {
    await page.goto(route.path);
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows, `${route.path} overflows horizontally`).toBe(false);
  }
});
