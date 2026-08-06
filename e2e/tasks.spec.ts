import { expect, test, type Locator, type Page } from "@playwright/test";

import { createAccount, deleteAccount, uniqueEmail } from "./helpers/accounts";
import { fillForm, signIn } from "./helpers/forms";
import { dayFromToday, hoursFromNow, seedTask } from "./helpers/tasks";

/**
 * The phase-2 acceptance journey, end to end, through a real browser.
 *
 * Covers the criteria from `docs/gsd/phase-2-discuss.md` that only count if
 * something actually walks them: 8 (no deadline is never overdue), 9 (overdue is
 * shown *beside* the real status, not instead of it), 10 (finishing a task
 * empties the bucket with no job), and 12 (a `done` task keeps the progress its
 * owner left it at). The rest of phase 2 — the overdue predicate itself, the
 * timezone arithmetic, the Zod bounds, the RLS boundary — is proven by unit and
 * integration tests, which are the right place for them.
 *
 * ## Selectors, and why they are all roles
 *
 * `TaskListLayout` renders **both** presentations on every page: a `<Table>`
 * inside `hidden md:block` and a card stack inside `md:hidden`. So each task's
 * controls exist twice in the DOM, and exactly one copy is `display: none`.
 * Playwright's role engine ignores what the accessibility tree ignores, so
 * `getByRole` resolves to the visible presentation and the same line works in
 * the `chromium` and `mobile` projects without a branch. A CSS or test-id
 * selector would match both and fail strict mode on one of the two.
 *
 * That only holds because `TaskRow` and `TaskCard` give their controls the same
 * accessible names — `Edit <title>`, `Status of <title>`, `Progress of <title>`.
 * `taskControls()` below is the single place that spells them.
 *
 * ## Waiting
 *
 * The dialog closes on a successful create/update/delete, and a finished task
 * leaves Overdue on the refetch that follows, so most steps have a UI signal to
 * wait on. The two inline controls do not — a row whose progress just saved
 * looks exactly like one whose progress has not — so those wait on the tRPC
 * response before reloading, rather than on a sleep.
 */

/** A page, or a region within one. Both expose the locator factories used here. */
type Scope = Page | Locator;

/**
 * One task's controls, wherever it is being rendered.
 *
 * `exact` matters: titles in these specs share a stamp, and the default
 * substring match would let `Edit <old title>` keep matching after a rename to a
 * longer string — turning "the old name is gone" into an assertion that cannot
 * fail.
 */
function taskControls(scope: Scope, title: string) {
  return {
    edit: scope.getByRole("button", { name: `Edit ${title}`, exact: true }),
    status: scope.getByRole("combobox", {
      name: `Status of ${title}`,
      exact: true,
    }),
    progress: scope.getByRole("slider", {
      name: `Progress of ${title}`,
      exact: true,
    }),
  };
}

/**
 * Resolves when the server has acknowledged a tRPC procedure.
 *
 * Create the promise *before* the action, then await it after. The link batches,
 * so the path can name more than one procedure — hence a substring test.
 */
function acknowledged(page: Page, procedure: string): Promise<unknown> {
  return page.waitForResponse(
    (response) => response.url().includes(procedure) && response.ok(),
  );
}

/**
 * The empty-state title, in whichever presentation is on screen.
 *
 * By role, like everything else here — the title is a real heading, so this
 * resolves to the visible copy and needs no visibility filter of its own. Worth
 * asserting before any "it is not here" count: an empty state means the query
 * *resolved* empty, whereas a count of zero is also what a list still loading
 * looks like.
 */
function emptyState(scope: Scope, text: string): Locator {
  return scope.getByRole("heading", { name: text, exact: true });
}

test("a one-off task is created, edited, progressed, finished and deleted", async ({
  page,
}) => {
  const email = uniqueEmail("task-journey");
  await createAccount(email, "active");
  await signIn(page, email);
  await page.waitForURL(/\/today/);

  const stamp = Date.now();
  const title = `Draft the changelog ${stamp}`;
  // Deliberately not an extension of `title`: see the note on `exact` above.
  const renamed = `Ship the changelog ${stamp}`;

  await test.step("create it through the dialog", async () => {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await fillForm([[dialog.getByLabel(/^title$/i), title]]);
    await dialog.getByRole("button", { name: "Create task" }).click();

    // The dialog closes on success only, so its absence is the acknowledgement.
    await expect(dialog).toHaveCount(0);
    await expect(taskControls(page, title).edit).toBeVisible();

    await page.reload();
    await expect(taskControls(page, title).edit).toBeVisible();
  });

  await test.step("edit the title, and the new one survives a reload", async () => {
    await taskControls(page, title).edit.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^title$/i)).toHaveValue(title);
    await fillForm([[dialog.getByLabel(/^title$/i), renamed]]);
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(taskControls(page, renamed).edit).toBeVisible();
    await expect(taskControls(page, title).edit).toHaveCount(0);
  });

  await test.step("set progress by hand, and it sticks", async () => {
    const { progress } = taskControls(page, renamed);

    // `fill` moves the range and fires `input`; the control commits on release,
    // and `blur` is the release a programmatic fill does not otherwise produce.
    const saved = acknowledged(page, "task.update");
    await progress.fill("40");
    await progress.blur();
    await saved;

    await page.reload();
    await expect(taskControls(page, renamed).progress).toHaveValue("40");
    // The `<output>` beside the slider — role `status`, and the only one on a
    // page showing a single task.
    await expect(page.getByRole("status")).toHaveText("40%");
  });

  await test.step("criterion 12 — done at 40% keeps both facts", async () => {
    const saved = acknowledged(page, "task.update");
    await taskControls(page, renamed).status.selectOption("done");
    await saved;

    await page.reload();
    // Both, explicitly. The regression this guards against is a status control
    // that helpfully rounds progress up to 100 on the way to done, which would
    // destroy the more interesting of the two numbers.
    await expect(taskControls(page, renamed).status).toHaveValue("done");
    await expect(taskControls(page, renamed).progress).toHaveValue("40");
    await expect(page.getByRole("status")).toHaveText("40%");
  });

  await test.step("delete it, with the second click the dialog asks for", async () => {
    await taskControls(page, renamed).edit.click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog.getByRole("button", { name: "Confirm delete" }).click();
    await expect(dialog).toHaveCount(0);

    await page.reload();
    await expect(emptyState(page, "No tasks yet")).toBeVisible();
    await expect(taskControls(page, renamed).edit).toHaveCount(0);
  });

  await deleteAccount(email);
});

test("criteria 9 and 10 — an overdue task keeps its real status, and finishing it clears the bucket", async ({
  page,
}) => {
  const email = uniqueEmail("task-overdue");
  const userId = await createAccount(email, "active");

  // Seeded rather than typed: a deadline three hours *before* `now()` is the one
  // arrangement `<input type="datetime-local">` makes awkward to state exactly,
  // since it takes a wall-clock reading with no zone. Everything asserted below
  // still happens through the browser.
  const late = `Renew the certificate ${Date.now()}`;
  await seedTask(userId, {
    title: late,
    occursOn: dayFromToday(0),
    deadlineAt: hoursFromNow(-3),
    status: "in_progress",
    progressPct: 25,
  });

  await signIn(page, email);
  await page.waitForURL(/\/today/);

  const overdue = page.getByRole("region", { name: "Overdue" });
  const today = page.getByRole("region", { name: "Today" });

  await test.step("criterion 9 — it is in the Overdue group on /today, still in progress", async () => {
    await expect(taskControls(overdue, late).edit).toBeVisible();
    await expect(taskControls(overdue, late).status).toHaveValue("in_progress");

    // Overdue is a derived bucket, not a fourth status: the control a late task
    // offers is the same three-value control every other task offers.
    await expect(taskControls(overdue, late).status.locator("option")).toHaveText(
      ["To do", "In progress", "Done"],
    );

    // And it is still on the day it is dated. Two groups, one row — neither is a
    // copy of the other.
    await expect(taskControls(today, late).edit).toBeVisible();
  });

  await test.step("criterion 9 — /overdue shows the same task and the same status", async () => {
    await page.goto("/overdue");
    await expect(taskControls(page, late).edit).toBeVisible();
    await expect(taskControls(page, late).status).toHaveValue("in_progress");
  });

  await test.step("criterion 10 — marking it done empties the bucket, with no job and no waiting", async () => {
    await taskControls(page, late).status.selectOption("done");

    // Gone on the refetch the mutation triggers — no reload, no background job.
    await expect(emptyState(page, "Nothing overdue")).toBeVisible();
    await expect(taskControls(page, late).edit).toHaveCount(0);

    await page.reload();
    await expect(emptyState(page, "Nothing overdue")).toBeVisible();
    await expect(taskControls(page, late).edit).toHaveCount(0);
  });

  await test.step("criterion 10 — and it is gone from the group on /today too", async () => {
    await page.goto("/today");
    await expect(emptyState(overdue, "Nothing overdue")).toBeVisible();
    await expect(taskControls(overdue, late).edit).toHaveCount(0);

    // Not deleted — only no longer late. It is still on its day, now done.
    await expect(taskControls(today, late).edit).toBeVisible();
    await expect(taskControls(today, late).status).toHaveValue("done");
  });

  await deleteAccount(email);
});

test("criterion 8 — a task with no deadline is never overdue, however old it is", async ({
  page,
}) => {
  const email = uniqueEmail("task-undated");
  const userId = await createAccount(email, "active");

  const undated = `Sort out the old photos ${Date.now()}`;
  await seedTask(userId, {
    title: undated,
    occursOn: dayFromToday(-400),
    deadlineAt: null,
  });

  await signIn(page, email);
  await page.waitForURL(/\/today/);

  await test.step("the task exists", async () => {
    // Asserted first so the two absences below are facts about the predicate
    // rather than about an empty account.
    await page.goto("/tasks");
    await expect(taskControls(page, undated).edit).toBeVisible();
  });

  await test.step("but it is not on /overdue", async () => {
    await page.goto("/overdue");
    await expect(emptyState(page, "Nothing overdue")).toBeVisible();
    await expect(taskControls(page, undated).edit).toHaveCount(0);
  });

  await test.step("nor in the Overdue group on /today", async () => {
    await page.goto("/today");
    const overdue = page.getByRole("region", { name: "Overdue" });
    await expect(emptyState(overdue, "Nothing overdue")).toBeVisible();
    await expect(taskControls(overdue, undated).edit).toHaveCount(0);
  });

  await deleteAccount(email);
});
