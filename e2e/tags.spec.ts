import { expect, test, type Page } from "@playwright/test";

import { createAccount, deleteAccount, uniqueEmail } from "./helpers/accounts";
import { fillForm, selectForm, signIn } from "./helpers/forms";

/**
 * The phase-4 acceptance journey, through a real browser.
 *
 * The one thing here that only an end-to-end test can prove is **criterion 8**:
 * a filter applies to a repeat rule's *projected* occurrences as well as to the
 * rows in the database. Those two halves are filtered by different code in
 * different languages (`filterCondition` in SQL, `matchesFilters` in
 * TypeScript), and the failure mode is silent — the list is simply missing the
 * thing the user was looking for. So the journey deliberately puts a one-off and
 * a recurring task under the same tag and asserts the filter finds both.
 *
 * The rest — the unique index, the composite foreign keys, the cascade — is
 * proven in `tests/integration/rls-boundary.test.ts`, which is where a database
 * guarantee belongs.
 */

/** The count of a task's Edit buttons in whichever presentation is visible. */
function occurrenceCount(page: Page, title: string) {
  return page.getByRole("button", { name: `Edit ${title}`, exact: true });
}

test("a tag can be created, applied, and filtered on — including a repeating task", async ({
  page,
}) => {
  const email = uniqueEmail("tags-journey");
  await createAccount(email, "active");
  await signIn(page, email);
  await page.waitForURL(/\/today/);

  const stamp = Date.now();
  const tagName = `Focus${stamp}`;
  const oneOff = `Write the report ${stamp}`;
  const repeating = `Daily review ${stamp}`;
  // Deliberately shares no words with the two above, so the search assertions
  // cannot pass by accident.
  const untagged = `Buy milk ${stamp}`;

  await test.step("create the tag in Settings", async () => {
    await page.goto("/settings");

    await fillForm([[page.getByLabel("New tag", { exact: true }), tagName]]);
    await page.getByRole("button", { name: "Add tag", exact: true }).click();

    // It joins the list, which is the acknowledgement.
    await expect(
      page.getByRole("list", { name: "Your tags" }).getByText(tagName),
    ).toBeVisible();
  });

  await test.step("create a one-off task carrying it", async () => {
    await page.goto("/tasks");
    await page.getByRole("button", { name: "New task", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "New task" });
    await fillForm([[dialog.getByLabel("Title", { exact: true }), oneOff]]);
    await dialog.getByRole("checkbox", { name: tagName, exact: true }).check();
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toHaveCount(0);

    // The chip is on the row, under a group named for the task.
    await expect(
      page.getByRole("list", { name: `Tags on ${oneOff}` }).first(),
    ).toBeVisible();
  });

  await test.step("create a repeating task carrying it too", async () => {
    await page
      .getByRole("button", { name: "New repeating task", exact: true })
      .click();

    const dialog = page.getByRole("dialog", { name: "New repeating task" });
    await fillForm([[dialog.getByLabel("Title", { exact: true }), repeating]]);
    await selectForm([
      [dialog.getByLabel("Repeats", { exact: true }), "daily"],
      [dialog.getByLabel("Ends", { exact: true }), "after"],
    ]);
    await fillForm([
      [dialog.getByLabel("Number of times", { exact: true }), "3"],
    ]);
    await dialog.getByRole("checkbox", { name: tagName, exact: true }).check();
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Three occurrences, none of them a row in the database yet.
    await expect(occurrenceCount(page, repeating)).toHaveCount(3);
  });

  await test.step("create a third task with no tag, to have something to exclude", async () => {
    await page.getByRole("button", { name: "New task", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "New task" });
    await fillForm([[dialog.getByLabel("Title", { exact: true }), untagged]]);
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toHaveCount(0);

    await expect(occurrenceCount(page, untagged)).toHaveCount(1);
  });

  /**
   * CRITERION 8 / 9 — the assertion this whole spec exists for.
   *
   * The one-off is a row and is filtered in SQL. The three recurring occurrences
   * are projections of a rule, carry their tag by way of `series_tags`, and are
   * filtered in memory. If those two definitions ever drift, this step fails —
   * and it is the only place that would notice.
   */
  await test.step("filtering by the tag keeps the row AND the projections", async () => {
    await page
      .getByRole("checkbox", { name: `Filter by ${tagName}`, exact: true })
      .check();

    await expect(occurrenceCount(page, oneOff)).toHaveCount(1);
    await expect(occurrenceCount(page, repeating)).toHaveCount(3);
    // And the untagged one is gone.
    await expect(occurrenceCount(page, untagged)).toHaveCount(0);
  });

  await test.step("search narrows within the filter, on both halves", async () => {
    await page.getByLabel("Search", { exact: true }).fill("Daily review");

    await expect(occurrenceCount(page, repeating)).toHaveCount(3);
    await expect(occurrenceCount(page, oneOff)).toHaveCount(0);
  });

  await test.step("a filter matching nothing shows the empty state, not a spinner", async () => {
    await page.getByLabel("Search", { exact: true }).fill("nothing matches this");

    // Criterion 11: an empty *state*, which means the query resolved — a count
    // of zero is also what a list still loading looks like.
    await expect(
      page.getByRole("heading", { name: "No tasks yet" }).first(),
    ).toBeVisible();
  });

  await test.step("clearing every filter returns the unfiltered list", async () => {
    await page
      .getByRole("button", { name: "Clear filters", exact: true })
      .click();

    // Criterion 10: exactly what was there before any filter was touched.
    await expect(occurrenceCount(page, oneOff)).toHaveCount(1);
    await expect(occurrenceCount(page, repeating)).toHaveCount(3);
    await expect(occurrenceCount(page, untagged)).toHaveCount(1);
    await expect(page.getByLabel("Search", { exact: true })).toHaveValue("");
  });

  /**
   * Criterion 3, through the browser: deleting a tag takes it off everything and
   * deletes no work.
   */
  await test.step("deleting the tag detaches it and keeps every task", async () => {
    await page.goto("/settings");
    await page.getByRole("button", { name: `Delete ${tagName}` }).click();
    await page
      .getByRole("button", { name: `Confirm delete ${tagName}` })
      .click();

    await expect(
      page.getByRole("list", { name: "Your tags" }).getByText(tagName),
    ).toHaveCount(0);

    await page.goto("/tasks");
    await expect(occurrenceCount(page, oneOff)).toHaveCount(1);
    await expect(occurrenceCount(page, repeating)).toHaveCount(3);
    // The chips are gone with it.
    await expect(
      page.getByRole("list", { name: `Tags on ${oneOff}` }),
    ).toHaveCount(0);
  });

  await deleteAccount(email);
});
