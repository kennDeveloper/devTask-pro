import { expect, test, type Locator, type Page } from "@playwright/test";

import { createAccount, deleteAccount, uniqueEmail } from "./helpers/accounts";
import { fillForm, selectForm, signIn } from "./helpers/forms";
import { dayFromToday, seedSeries } from "./helpers/tasks";

/**
 * The phase-3 acceptance journey, end to end, through a real browser.
 *
 * Covers the criteria that only count if something actually walks them:
 * **3/[14]** setting one occurrence persists that row and leaves its neighbours
 * alone; **4/[15]** editing the rule moves the untouched occurrences and leaves
 * the touched one exactly as it was; **5/[17]** deleting the series takes the
 * untouched future with it and leaves the recorded history standing; and
 * **13/14** that a recurring occurrence is an ordinary row with one extra
 * control, named identically in both presentations.
 *
 * The rest of phase 3 — the expander, the round trip, the DST arithmetic, the
 * partial unique index, the RLS boundary — is proven by unit and integration
 * tests, which are the right place for them.
 *
 * ## Selectors, and why several of them carry an index
 *
 * `TaskListLayout` renders **both** presentations on every page, and
 * `getByRole` resolves to the visible one — that is the rule `AGENTS.md`
 * records and it still holds. What is new in this phase is that a series
 * produces *several* occurrences with the *same* title, so `Edit <title>`
 * legitimately matches more than one. Adding the date to each control's
 * accessible name would break the phase-2 contract that `task-row.tsx` and
 * `task-card.tsx` name things identically, so the occurrences are told apart by
 * position instead — which is deterministic, because `/tasks` is ordered newest
 * day first. Every use of `.nth()` below is preceded by an assertion pinning how
 * many there are, so an index can never quietly point at the wrong row.
 *
 * ## Dates
 *
 * `createAccount` leaves the profile at the schema default timezone, `UTC`, so
 * the app's "today" is the UTC calendar day and `dayFromToday()` computes
 * exactly that. No deadline time is set on any series here: an occurrence with
 * no deadline is never overdue, which keeps these assertions about recurrence
 * rather than about the overdue bucket.
 */

type Scope = Page | Locator;

/**
 * One occurrence's controls, by position in the list.
 *
 * `exact` matters for the same reason it does in `tasks.spec.ts`: titles share a
 * stamp, and a substring match would let a stale name keep matching.
 */
function occurrence(scope: Scope, title: string, index: number) {
  return {
    edit: scope
      .getByRole("button", { name: `Edit ${title}`, exact: true })
      .nth(index),
    status: scope
      .getByRole("combobox", { name: `Status of ${title}`, exact: true })
      .nth(index),
    progress: scope
      .getByRole("slider", { name: `Progress of ${title}`, exact: true })
      .nth(index),
    repeat: scope
      .getByRole("button", { name: `Repeat rule of ${title}`, exact: true })
      .nth(index),
  };
}

/** How many occurrences of `title` the visible presentation is showing. */
function occurrenceCount(scope: Scope, title: string): Locator {
  return scope.getByRole("button", { name: `Edit ${title}`, exact: true });
}

/** Resolves when the server has acknowledged a tRPC procedure. */
function acknowledged(page: Page, procedure: string): Promise<unknown> {
  return page.waitForResponse(
    (response) => response.url().includes(procedure) && response.ok(),
  );
}

test("a repeat rule produces one trackable occurrence per date, each with its own state", async ({
  page,
}) => {
  const email = uniqueEmail("series-journey");
  await createAccount(email, "active");
  await signIn(page, email);
  await page.waitForURL(/\/today/);

  const stamp = Date.now();
  const title = `Daily standup ${stamp}`;

  await test.step("create the rule through the dialog", async () => {
    await page.goto("/tasks");
    await page
      .getByRole("button", { name: "New repeating task", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "New repeating task" });

    // Never a bare `fill()` — a controlled input filled between the HTML
    // arriving and React hydrating takes the raw DOM value and dispatches an
    // event nobody is listening to yet. `fillForm` re-fills until the values
    // survive. See `e2e/helpers/forms.ts`.
    await fillForm([[dialog.getByLabel("Title", { exact: true }), title]]);

    // Daily, three times, starting today: today, tomorrow, the day after.
    //
    // Through `selectForm` rather than a bare `selectOption` for the reason
    // `fillForm` exists — a controlled `<select>` set before hydration is put
    // back by the first controlled render, and the form then submits a rule
    // nobody chose without erroring.
    await selectForm([
      [dialog.getByLabel("Repeats", { exact: true }), "daily"],
      [dialog.getByLabel("Ends", { exact: true }), "after"],
    ]);
    await fillForm([
      [dialog.getByLabel("Number of times", { exact: true }), "3"],
    ]);

    // The preview says what is about to be saved, in the same words the list
    // will use. Asserted *before* submitting, so a control that did not take
    // fails here — where the cause is one line up — rather than three steps
    // later as a wrong occurrence count.
    await expect(dialog.getByRole("status")).toHaveText("Every day, 3 times");

    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    // The dialog closes on success only, so its absence is the acknowledgement.
    await expect(dialog).toHaveCount(0);
  });

  await test.step("criterion 13 — one row per occurrence, and it survives a reload", async () => {
    await expect(occurrenceCount(page, title)).toHaveCount(3);
    await page.reload();
    await expect(occurrenceCount(page, title)).toHaveCount(3);

    // Ordered newest day first, so index 2 is today.
    await expect(occurrence(page, title, 2).status).toHaveValue("todo");
    await expect(occurrence(page, title, 2).progress).toHaveValue("0");
  });

  await test.step("criterion 13 — identical to a one-off but for the repeat affordance", async () => {
    // The same three controls every task has, plus exactly one more.
    await expect(occurrence(page, title, 0).status).toBeVisible();
    await expect(occurrence(page, title, 0).progress).toBeVisible();
    await expect(occurrence(page, title, 0).repeat).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Repeat rule of ${title}`, exact: true }),
    ).toHaveCount(3);
  });

  await test.step("criterion 3/[14] — touching #3 persists it and leaves the others alone", async () => {
    const saved = acknowledged(page, "task.update");
    await occurrence(page, title, 2).status.selectOption("in_progress");
    await saved;

    // The two inline controls have no UI signal of their own, so the progress
    // write waits on the response rather than on a sleep.
    const progressSaved = acknowledged(page, "task.update");
    await occurrence(page, title, 2).progress.fill("60");
    await occurrence(page, title, 2).progress.blur();
    await progressSaved;

    await page.reload();

    // Still three occurrences — touching one materialises a row where a
    // projection was, it does not add anything.
    await expect(occurrenceCount(page, title)).toHaveCount(3);

    await expect(occurrence(page, title, 2).status).toHaveValue("in_progress");
    await expect(occurrence(page, title, 2).progress).toHaveValue("60");

    // #1 and #2 untouched. This is the assertion the criterion is about: one
    // occurrence carries state and its neighbours are still projections of the
    // same rule.
    for (const index of [0, 1]) {
      await expect(occurrence(page, title, index).status).toHaveValue("todo");
      await expect(occurrence(page, title, index).progress).toHaveValue("0");
    }
  });

  await test.step("criterion 4/[15] — editing the rule moves the untouched ones and keeps the touched one", async () => {
    // Move the start forward a day. The new rule names tomorrow, +2 and +3; the
    // occurrence that carries work is dated today, which the rule no longer
    // names at all — and it has to stay.
    await occurrence(page, title, 2).repeat.click();

    const dialog = page.getByRole("dialog", { name: "Edit repeat rule" });
    await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue(title);
    await fillForm([
      [dialog.getByLabel("Starts on", { exact: true }), dayFromToday(1)],
    ]);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);

    await page.reload();

    // Four now: the three the new rule names, plus the one that holds work.
    await expect(occurrenceCount(page, title)).toHaveCount(4);

    // Newest first, so the recorded one is last — and it kept **both** facts.
    await expect(occurrence(page, title, 3).status).toHaveValue("in_progress");
    await expect(occurrence(page, title, 3).progress).toHaveValue("60");

    // And the three the new rule produced are untouched projections.
    for (const index of [0, 1, 2]) {
      await expect(occurrence(page, title, index).status).toHaveValue("todo");
    }
  });

  await test.step("criterion 5/[17] — deleting the series clears the untouched future and keeps the record", async () => {
    await occurrence(page, title, 0).repeat.click();

    const dialog = page.getByRole("dialog", { name: "Edit repeat rule" });
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Confirm delete", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);

    await page.reload();

    // One left: the occurrence somebody actually worked on.
    await expect(occurrenceCount(page, title)).toHaveCount(1);
    await expect(occurrence(page, title, 0).status).toHaveValue("in_progress");
    await expect(occurrence(page, title, 0).progress).toHaveValue("60");
  });

  await deleteAccount(email);
});

test("a weekly rule fires only on the days it names, and its occurrence dialog defers to the rule", async ({
  page,
}) => {
  const email = uniqueEmail("series-weekly");
  const userId = await createAccount(email, "active");

  // Seeded rather than typed: this spec is about what the app does with a rule
  // that names a specific set of weekdays, and reaching those days through the
  // picker would make the assertion depend on which day the suite runs. The
  // creation path itself is walked in full by the test above.
  const title = `Weekly review ${Date.now()}`;
  await seedSeries(userId, {
    title,
    freq: "weekly",
    // Every weekday, so the next seven days always contain five of them
    // whatever day the suite runs on.
    byweekday: ["MO", "TU", "WE", "TH", "FR"],
    startsOn: dayFromToday(0),
    endsCount: 5,
  });

  await signIn(page, email);
  await page.waitForURL(/\/today/);

  await test.step("five occurrences, from a rule the browser never expanded", async () => {
    await page.goto("/tasks");
    await expect(occurrenceCount(page, title)).toHaveCount(5);
  });

  await test.step("the occurrence dialog defers the day to the rule and offers no delete", async () => {
    await occurrence(page, title, 0).edit.click();

    const dialog = page.getByRole("dialog", { name: "Edit task" });

    // The day belongs to the rule: writing a row on some other date would put
    // an occurrence on a day its series never names.
    await expect(dialog.getByLabel("Day", { exact: false })).toBeDisabled();

    // No delete, because it would not stick — the rule produces the date again
    // on the next read. The repeat button is the way to change what a series
    // produces.
    await expect(
      dialog.getByRole("button", { name: "Delete", exact: true }),
    ).toHaveCount(0);

    // The controls that *are* the occurrence's own remain editable.
    await expect(dialog.getByLabel("Status", { exact: true })).toBeEnabled();
    await expect(dialog.getByLabel("Progress", { exact: true })).toBeEnabled();
  });

  await test.step("the rule editor opens on the seeded rule", async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await occurrence(page, title, 0).repeat.click();
    const dialog = page.getByRole("dialog", { name: "Edit repeat rule" });

    await expect(dialog.getByLabel("Repeats", { exact: true })).toHaveValue(
      "weekly",
    );
    await expect(dialog.getByRole("checkbox", { name: "Monday" })).toBeChecked();
    await expect(
      dialog.getByRole("checkbox", { name: "Saturday" }),
    ).not.toBeChecked();
    await expect(dialog.getByRole("status")).toContainText("5 times");
  });

  await deleteAccount(email);
});
