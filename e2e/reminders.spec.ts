import { expect, test, type APIRequestContext } from "@playwright/test";

import { createAccount, deleteAccount, uniqueEmail } from "./helpers/accounts";
import { fillForm, signIn } from "./helpers/forms";
import { messagesFor } from "./helpers/mailpit";
import { hoursFromNow, seedTask } from "./helpers/tasks";

/**
 * Phase 6's acceptance journey, end to end — through a real browser, a real SMTP
 * connection and the stack's own mail catcher.
 *
 * Two halves, and both need a browser or a network to mean anything:
 *
 *   1. **A reminder can be set from the UI and it persists.** Asserted by role,
 *      like every other control in this suite, so one line covers the table and
 *      the card presentations that both render on every page.
 *   2. **Criterion 21 through the actual endpoint.** Hitting the cron route
 *      twice must leave exactly one message in the inbox. The unit and
 *      integration suites prove the claim mechanism; this proves the whole
 *      chain, including that SMTP is wired at all.
 *
 * ## Why the reminded task is seeded rather than typed
 *
 * The job compares against `now()` at the moment the request lands, so the
 * arrangement is "a deadline a known number of minutes in the future" — which
 * through `<input type="datetime-local">` means doing the zone arithmetic in the
 * spec that `localInputToInstant` exists to do in the app. That is exactly the
 * carve-out `e2e/helpers/tasks.ts` describes. The *reminder setting* is still
 * exercised through the real dialog, in the first half.
 *
 * ## The label regexes are prefixes, not anchored
 *
 * `Field` renders an optional field's label as "Reminder · optional", so
 * `/^reminder$/i` matches nothing. Every other spec in this suite happens to
 * target required fields, which is why this is the first place it bites.
 *
 * ## Why no `expect` on Mailpit counts without a reload guard
 *
 * The inbox is global to the stack, so every assertion here filters by this
 * spec's own unique address. Two projects (`chromium` and `mobile`) run this
 * file concurrently against one server and one Mailpit; unique addresses are
 * what keeps them from reading each other's mail.
 */

const CRON_PATH = "/api/cron/reminders";

/** Invoke the job the way Vercel Cron does. */
function runJob(request: APIRequestContext) {
  return request.get(CRON_PATH, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });
}

test("a reminder is set in the dialog and survives a reload", async ({ page }) => {
  const email = uniqueEmail("reminder-ui");
  await createAccount(email, "active");
  await signIn(page, email);
  await page.waitForURL(/\/today/);

  const title = `Write the release notes ${Date.now()}`;

  await test.step("the control is disabled until there is a deadline", async () => {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();

    const dialog = page.getByRole("dialog");
    const reminder = dialog.getByRole("combobox", { name: /^reminder/i });

    // A lead counts back from a deadline; without one it has nothing to mean.
    await expect(reminder).toBeDisabled();
  });

  await test.step("create the task with a deadline and a reminder", async () => {
    const dialog = page.getByRole("dialog");

    await fillForm([
      [dialog.getByLabel(/^title$/i), title],
      [dialog.getByLabel(/^deadline/i), "2026-12-31T09:00"],
    ]);

    const reminder = dialog.getByRole("combobox", { name: /^reminder/i });
    await expect(reminder).toBeEnabled();
    await reminder.selectOption({ label: "30 minutes before" });

    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toHaveCount(0);
  });

  await test.step("it is still 30 minutes before after a reload", async () => {
    await page.reload();
    await page
      .getByRole("button", { name: `Edit ${title}`, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("combobox", { name: /^reminder/i }),
    ).toHaveValue("30");
  });

  await test.step("switching it off persists too", async () => {
    const dialog = page.getByRole("dialog");
    const reminder = dialog.getByRole("combobox", { name: /^reminder/i });

    await reminder.selectOption({ label: "No reminder" });
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await page
      .getByRole("button", { name: `Edit ${title}`, exact: true })
      .click();
    await expect(
      page.getByRole("dialog").getByRole("combobox", { name: /^reminder/i }),
    ).toHaveValue("none");
  });

  await deleteAccount(email);
});

test("the cron route sends one reminder, and sends nothing the second time", async ({
  request,
}) => {
  const email = uniqueEmail("reminder-send");
  const id = await createAccount(email, "active");

  // Due in ten minutes with a thirty-minute lead: the window opened twenty
  // minutes ago and closes in ten, so the job should send on the next tick.
  await seedTask(id, {
    title: "Deploy the reminder job",
    deadlineAt: hoursFromNow(10 / 60),
    reminderLeadMinutes: 30,
  });

  await test.step("the first run delivers", async () => {
    const response = await runJob(request);
    expect(response.ok()).toBe(true);

    const summary = await response.json();
    expect(summary.sent).toBeGreaterThanOrEqual(1);

    await expect
      .poll(async () => (await messagesFor(email)).length, {
        message: "the reminder never arrived in Mailpit",
      })
      .toBe(1);
  });

  await test.step("CRITERION 21 — the second run delivers nothing", async () => {
    const response = await runJob(request);
    expect(response.ok()).toBe(true);

    // Still exactly one. A ledger row already existed, so nothing was claimed
    // and nothing was sent.
    await expect
      .poll(async () => (await messagesFor(email)).length)
      .toBe(1);
  });

  await deleteAccount(email);
});

test("the cron route refuses a request without the secret", async ({ request }) => {
  const withoutHeader = await request.get(CRON_PATH);
  expect(withoutHeader.status()).toBe(401);

  const wrongSecret = await request.get(CRON_PATH, {
    headers: { Authorization: "Bearer not-the-secret" },
  });
  expect(wrongSecret.status()).toBe(401);
});

test("CRITERION 22 — a finished task is never reminded about", async ({
  request,
}) => {
  const email = uniqueEmail("reminder-done");
  const id = await createAccount(email, "active");

  await seedTask(id, {
    title: "Already finished",
    deadlineAt: hoursFromNow(10 / 60),
    reminderLeadMinutes: 30,
    status: "done",
  });

  const response = await runJob(request);
  expect(response.ok()).toBe(true);

  // Nothing to poll *for*, so give the job a moment and then assert the absence
  // — a bare check immediately after the response would also pass if the mail
  // were merely slow.
  await expect
    .poll(async () => (await messagesFor(email)).length, { timeout: 5_000 })
    .toBe(0);

  await deleteAccount(email);
});
