import { expect, test } from "@playwright/test";

import {
  TEST_PASSWORD,
  createAccount,
  deleteAccount,
  getProfile,
  setStatus,
  uniqueEmail,
} from "./helpers/accounts";
import { clearInbox, confirmationLinkFor } from "./helpers/mailpit";

/**
 * The phase-1 acceptance journey, end to end, through the real UI and real mail.
 *
 * Covers brief criteria 1-5 from docs/gsd/devtask-pro-v1.md. Everything else in
 * phase 1 is proven by unit or integration tests; this is the part that only counts
 * if a browser actually walks it.
 */

test.describe.configure({ mode: "serial" });

test("a new signup is gated, then approved, then let in", async ({ page }) => {
  const email = uniqueEmail("journey");
  await clearInbox();

  await test.step("sign up", async () => {
    await page.goto("/sign-up");
    await page.getByLabel(/^email$/i).fill(email);
    await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
    await page.getByLabel(/confirm/i).fill(TEST_PASSWORD);
    await page.getByRole("button", { name: /create account|sign up/i }).click();

    // Confirmations are on: no session, an inbox prompt instead.
    await expect(page.getByText(/check your inbox/i)).toBeVisible();
  });

  await test.step("the trigger created a pending profile", async () => {
    const profile = await getProfile(email);
    expect(profile).not.toBeNull();
    expect(profile!.status).toBe("pending");
    expect(profile!.role).toBe("member");
  });

  await test.step("confirming the address lands on /pending, not the app", async () => {
    // Goes to GoTrue's /auth/v1/verify, which 302s to /auth/callback for the PKCE
    // exchange, after which the proxy routes on status. One click, whole chain.
    await page.goto(await confirmationLinkFor(email));
    await page.waitForURL(/\/pending/);
    await expect(page.getByText(/awaiting approval/i)).toBeVisible();
  });

  await test.step("criterion 1 — a confirmed but unapproved user cannot reach the app", async () => {
    await page.goto("/today");
    await page.waitForURL(/\/pending/);
    await expect(page).toHaveURL(/\/pending/);
  });

  await test.step("criterion 2 — after approval they reach /today with no re-signup", async () => {
    await setStatus(email, "active");
    await page.goto("/today");
    await page.waitForURL(/\/today/);
    await expect(page).toHaveURL(/\/today/);
  });

  await test.step("criterion 4 — suspension bites on the very next request", async () => {
    // The access token issued at sign-in is still perfectly valid here. Only a live
    // read of profiles.status can catch this; a proxy trusting JWT claims would let
    // them keep working until the token expired.
    await setStatus(email, "suspended");
    await page.goto("/today");
    await page.waitForURL(/\/no-access/);
    await expect(page).toHaveURL(/\/no-access/);
  });

  await deleteAccount(email);
});

test("criterion 3 — a rejected account sees /no-access", async ({ page }) => {
  const email = uniqueEmail("rejected");
  await createAccount(email, "rejected");

  await page.goto("/sign-in");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  await page.waitForURL(/\/no-access/);
  await expect(page).toHaveURL(/\/no-access/);

  await deleteAccount(email);
});

test("criterion 5 — a non-admin cannot render an admin route", async ({ page }) => {
  const email = uniqueEmail("member");
  await createAccount(email, "active", "member");

  await page.goto("/sign-in");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/today/);

  // The admin tier itself is phase 5. What must hold NOW is that the route does not
  // render an admin page — a 404 is the correct outcome while it does not exist.
  const response = await page.goto("/admin/users");
  expect(response?.status()).toBe(404);

  await deleteAccount(email);
});

test("an unconfirmed account gets its own message, not 'bad credentials'", async ({
  page,
}) => {
  const email = uniqueEmail("unconfirmed");
  await clearInbox();

  await page.goto("/sign-up");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
  await page.getByLabel(/confirm/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /create account|sign up/i }).click();
  await expect(page.getByText(/check your inbox/i)).toBeVisible();

  await page.goto("/sign-in");
  await page.getByLabel(/^email$/i).fill(email);
  await page.getByLabel(/^password$/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page.getByText(/confirm/i).first()).toBeVisible();

  await deleteAccount(email);
});

test("signed out, a protected route redirects to sign-in", async ({ page }) => {
  await page.goto("/today");
  await page.waitForURL(/\/sign-in/);
  await expect(page).toHaveURL(/\/sign-in/);
});
