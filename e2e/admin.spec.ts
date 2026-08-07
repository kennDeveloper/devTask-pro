import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  createAccount,
  deleteAccount,
  getProfile,
  uniqueEmail,
} from "./helpers/accounts";
import { fillForm, signIn } from "./helpers/forms";
import { clearInbox, latestFor, linkFromMessage } from "./helpers/mailpit";

/**
 * The phase-5 acceptance journey, end to end, through the real UI and real mail.
 *
 * Phase 1 built the gates and proved them by editing rows directly — its own
 * helper says so: *"These stand in for the admin tier, which does not exist
 * until phase 5."* This spec is what replaces that. Every status change below
 * happens because somebody clicked a button in a browser.
 *
 * ## Two contexts, and why the suspension test needs them
 *
 * Criterion 3 is not "a suspended user cannot sign in" — it is *"suspending a
 * user **with a live session** terminates it"*. Proving that needs the member to
 * be genuinely signed in and sitting in the app while the admin acts, which
 * means a second browser context with its own cookie jar. Asserting it with one
 * context, by signing the member in afterwards, would prove something phase 1
 * already proved.
 *
 * ## Selectors
 *
 * By role, never CSS or test id — every list renders **both** presentations at
 * once (a `<Table>` in `hidden md:block` and a card stack in `md:hidden`), so
 * each account's controls exist twice in the DOM with exactly one copy
 * displayed. Playwright's role engine ignores what the accessibility tree
 * ignores, so one line covers both the `chromium` and `mobile` projects. That
 * works because `AccountRow` and `AccountCard` render the same
 * `<AccountActions>` component — see the note in that file.
 *
 * And never a bare `fill()`: `fillForm()` re-fills until the values survive
 * hydration. See `e2e/helpers/forms.ts`.
 */

/** Sign in as a fresh administrator and land on the tier. */
async function signInAsAdmin(page: Page): Promise<string> {
  const email = uniqueEmail("admin");
  await createAccount(email, "active", "admin");

  await signIn(page, email);
  await page.waitForURL(/\/admin\/users/);

  return email;
}

/** A second browser with its own cookie jar, for the member half of a journey. */
async function openMemberContext(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

/**
 * The row's action button, addressed the way the component names it:
 * `"Approve ada@example.com"`. One locator resolves to whichever of the table
 * row or the card is displayed at this viewport.
 */
function action(page: Page, label: string, email: string) {
  return page.getByRole("button", { name: `${label} ${email}` });
}

test("an admin lands on their own tier, and cannot see the task app", async ({
  page,
}) => {
  const admin = await signInAsAdmin(page);

  await test.step("sign-in lands on /admin/users, not /today", async () => {
    await expect(page).toHaveURL(/\/admin\/users/);
    await expect(
      page.getByRole("heading", { name: "Accounts", level: 1 }),
    ).toBeVisible();
  });

  await test.step("criterion 11 — no task destination is rendered", async () => {
    for (const href of ["/today", "/tasks", "/overdue", "/settings"]) {
      await expect(page.locator(`a[href="${href}"]`)).toHaveCount(0);
    }
  });

  await test.step("criterion 11 — no task destination is reachable either", async () => {
    // The tiers are disjoint: an admin asking for the member app is sent home
    // rather than shown a shell whose whole job is linking to task routes.
    for (const path of ["/today", "/tasks", "/overdue", "/settings"]) {
      await page.goto(path);
      await page.waitForURL(/\/admin\/users/);
      await expect(page).toHaveURL(/\/admin\/users/);
    }
  });

  await test.step("/admin forwards to the one destination the tier has", async () => {
    await page.goto("/admin");
    await page.waitForURL(/\/admin\/users/);
  });

  await test.step("the admin's own row offers no way to change their own gate", async () => {
    await page.goto("/admin/users");
    for (const label of ["Approve", "Reject", "Suspend", "Reinstate"]) {
      await expect(action(page, label, admin)).toHaveCount(0);
    }
  });

  await deleteAccount(admin);
});

test("criterion 5 — a member gets a 404 from the admin tier, not a page", async ({
  page,
}) => {
  const member = uniqueEmail("member");
  await createAccount(member, "active", "member");

  await signIn(page, member);
  await page.waitForURL(/\/today/);

  // The route exists now, so this is the (admin) layout's `notFound()` doing
  // the work rather than the router failing to match — which is what makes the
  // assertion mean something it did not mean in phase 1.
  const response = await page.goto("/admin/users");
  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Accounts", level: 1 }),
  ).toHaveCount(0);

  await deleteAccount(member);
});

test("criterion 1 — approving lets a pending user in, with no re-signup", async ({
  page,
  browser,
}) => {
  const admin = await signInAsAdmin(page);
  const member = uniqueEmail("approve-me");
  await createAccount(member, "pending", "member");

  const { context, page: memberPage } = await openMemberContext(browser);

  await test.step("the member signs in and is held at /pending", async () => {
    await signIn(memberPage, member);
    await memberPage.waitForURL(/\/pending/);
  });

  await test.step("the admin approves them, through the UI", async () => {
    await page.goto("/admin/users");
    await action(page, "Approve", member).click();

    // The row moves out of the pending queue: Approve is replaced by Suspend.
    await expect(action(page, "Suspend", member)).toBeVisible();
    await expect(action(page, "Approve", member)).toHaveCount(0);
  });

  await test.step("the same session now reaches /today", async () => {
    // No second sign-in. The token the member is holding was issued before the
    // approval and is still the one in play — approval has to bite on the row.
    await memberPage.goto("/today");
    await memberPage.waitForURL(/\/today/);
    await expect(memberPage).toHaveURL(/\/today/);
  });

  await test.step("the decision is recorded", async () => {
    const profile = await getProfile(member);
    expect(profile!.status).toBe("active");
  });

  await context.close();
  await deleteAccount(member);
  await deleteAccount(admin);
});

test("criterion 2 — rejecting sends a user to /no-access, and it confirms first", async ({
  page,
  browser,
}) => {
  const admin = await signInAsAdmin(page);
  const member = uniqueEmail("reject-me");
  await createAccount(member, "pending", "member");

  await page.goto("/admin/users");

  await test.step("criterion 13 — cancelling the confirm changes nothing", async () => {
    await action(page, "Reject", member).click();
    await expect(
      page.getByRole("heading", { name: /reject this signup\?/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Cancel" }).click();

    // Still pending: the row still offers both decisions.
    await expect(action(page, "Reject", member)).toBeVisible();
    await expect(action(page, "Approve", member)).toBeVisible();
    expect((await getProfile(member))!.status).toBe("pending");
  });

  await test.step("confirming it goes through", async () => {
    await action(page, "Reject", member).click();
    await page
      .getByRole("button", { name: `Confirm: Reject ${member}` })
      .click();

    // A rejected account can be let back in, so Approve is what remains.
    await expect(action(page, "Approve", member)).toBeVisible();
    await expect(action(page, "Reject", member)).toHaveCount(0);
  });

  await test.step("the member sees /no-access", async () => {
    const { context, page: memberPage } = await openMemberContext(browser);
    await signIn(memberPage, member);
    await memberPage.waitForURL(/\/no-access/);
    await expect(memberPage).toHaveURL(/\/no-access/);
    await context.close();
  });

  await deleteAccount(member);
  await deleteAccount(admin);
});

test("criteria 3 and 4 — suspending kills a live session, reinstating restores it", async ({
  page,
  browser,
}) => {
  const admin = await signInAsAdmin(page);
  const member = uniqueEmail("suspend-me");
  await createAccount(member, "active", "member");

  const { context, page: memberPage } = await openMemberContext(browser);

  await test.step("the member is signed in and working", async () => {
    await signIn(memberPage, member);
    await memberPage.waitForURL(/\/today/);
    await expect(memberPage).toHaveURL(/\/today/);
  });

  await test.step("the admin suspends them", async () => {
    await page.goto("/admin/users");
    await action(page, "Suspend", member).click();
    await page
      .getByRole("button", { name: `Confirm: Suspend ${member}` })
      .click();

    await expect(action(page, "Reinstate", member)).toBeVisible();
  });

  await test.step("criterion 3 — their very next request lands on /no-access", async () => {
    // The access token in that browser is still perfectly valid and unexpired.
    // Only the proxy's live `profiles.status` read catches this; a gate that
    // trusted the JWT's claims would let them work until it expired.
    await memberPage.goto("/today");
    await memberPage.waitForURL(/\/no-access/);
    await expect(memberPage).toHaveURL(/\/no-access/);
  });

  await test.step("criterion 4 — reinstating restores access with no re-signup", async () => {
    await action(page, "Reinstate", member).click();
    await expect(action(page, "Suspend", member)).toBeVisible();

    await memberPage.goto("/today");
    await memberPage.waitForURL(/\/today/);
    await expect(memberPage).toHaveURL(/\/today/);
  });

  await context.close();
  await deleteAccount(member);
  await deleteAccount(admin);
});

test("criterion 6 — an admin-triggered reset sets a new password and signs the user in", async ({
  page,
  browser,
}) => {
  const admin = await signInAsAdmin(page);
  const member = uniqueEmail("reset-me");
  await createAccount(member, "active", "member");

  const NEW_PASSWORD = "a-brand-new-passphrase-42";

  await clearInbox();

  await test.step("the admin triggers the reset", async () => {
    await page.goto("/admin/users");
    await page
      .getByRole("button", { name: `Send password reset to ${member}` })
      .click();

    await expect(page.getByText(/reset email sent/i)).toBeVisible();
  });

  await test.step("the admin is never shown the link itself", async () => {
    // `generateLink` would have handed a credential-bearing URL to this page —
    // an account takeover with a button. `resetPasswordForEmail` sends it to
    // the account holder instead, so there is nothing here to copy.
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/access_token|type=recovery|\/auth\/v1\/verify/);
  });

  const { context, page: memberPage } = await openMemberContext(browser);

  await test.step("the recovery link arrives and opens the reset form", async () => {
    const message = await latestFor(member);
    const link = await linkFromMessage(message.ID);

    // GoTrue's link hits /auth/v1/verify, which 302s to the `redirectTo`. An
    // admin-triggered reset is necessarily implicit-flow — the server cannot
    // hand a PKCE verifier to somebody else's browser — so the session arrives
    // in the URL *fragment* and only the browser can read it. That is why the
    // link aims at /reset-password rather than the PKCE callback: see
    // `src/lib/supabase/admin.ts`.
    await memberPage.goto(link);
    await memberPage.waitForURL(/\/reset-password/);

    // The page starts in a "checking" state and resolves to the form only once
    // the browser client has picked the session out of the fragment. Waiting on
    // the field rather than the heading is what proves that happened.
    await expect(memberPage.getByLabel(/^new password$/i)).toBeVisible();
  });

  await test.step("setting a new password lands them in the app", async () => {
    await fillForm([
      [memberPage.getByLabel(/^new password$/i), NEW_PASSWORD],
      [memberPage.getByLabel(/confirm new password/i), NEW_PASSWORD],
    ]);
    await memberPage.getByRole("button", { name: /save password/i }).click();

    await memberPage.waitForURL(/\/today/);
  });

  await test.step("the new password is the one that works now", async () => {
    const fresh = await openMemberContext(browser);
    await signIn(fresh.page, member, NEW_PASSWORD);
    await fresh.page.waitForURL(/\/today/);
    await expect(fresh.page).toHaveURL(/\/today/);
    await fresh.context.close();
  });

  await context.close();
  await deleteAccount(member);
  await deleteAccount(admin);
});

test("the list shows account metadata and nothing about anybody's work", async ({
  page,
}) => {
  const admin = await signInAsAdmin(page);
  const member = uniqueEmail("metadata");
  await createAccount(member, "active", "member");

  await page.goto("/admin/users");

  // Addressed by role, not by text. `getByText` matches the DOM regardless of
  // visibility, so it finds the row *and* the card and fails strict mode; the
  // role engine skips whichever presentation is `display:none`. This is the
  // AGENTS.md rule, and it caught this line the first time it was written.
  await expect(action(page, "Suspend", member)).toBeVisible();

  await test.step("criterion 12 — the columns are the account ones", async () => {
    // Desktop renders the table; the mobile project renders cards, where column
    // headers legitimately do not exist. Assert only where the table is shown.
    const table = page.getByRole("table", { name: "Accounts" });
    if (await table.isVisible()) {
      await expect(
        table.getByRole("columnheader", { name: "Account" }),
      ).toBeVisible();
      await expect(
        table.getByRole("columnheader", { name: "Last sign-in" }),
      ).toBeVisible();
    }
  });

  await test.step("criterion 6 of the brief — no task figure anywhere on the page", async () => {
    const body = (await page.locator("main").innerText()).toLowerCase();
    // The page's own copy says the word "task" while explaining that it shows
    // none, so the assertion is about a *count* rather than the word.
    expect(body).not.toMatch(/\d+\s+(open|overdue|todo|done|in progress)/);
    expect(body).not.toMatch(/\d+\s+tasks?\b/);
  });

  await deleteAccount(member);
  await deleteAccount(admin);
});
