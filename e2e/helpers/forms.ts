import { expect, type Locator, type Page } from "@playwright/test";

import { TEST_PASSWORD } from "./accounts";

/**
 * Form helpers for e2e.
 *
 * Every auth form is a controlled React form rendered on the server, so each one has a
 * window where its inputs exist in the DOM but React has not hydrated them yet. A value
 * typed into that window never reaches component state, and the first controlled render
 * wipes the field — the form then submits empty and stops on its own validation error,
 * which reads like a broken redirect and is not one.
 *
 * `/sign-in` is the worst case: it reads `useSearchParams`, so its form sits behind a
 * Suspense boundary and hydrates later still. WebKit loses that race on every run;
 * Chromium usually wins it, which is what makes this worth pinning down in one place
 * instead of leaving five racy copies inline in the specs.
 */

/**
 * Fill a set of fields and prove the values survived hydration.
 *
 * Fills every field, then re-reads them all — a value can be accepted and then wiped a
 * moment later, so checking each field as it is filled is not enough. Re-filling until
 * the whole form holds is what makes this deterministic without an arbitrary sleep.
 */
export async function fillForm(
  fields: Array<readonly [Locator, string]>,
): Promise<void> {
  await expect(async () => {
    for (const [field, value] of fields) {
      await field.fill(value);
    }
    for (const [field, value] of fields) {
      await expect(field).toHaveValue(value, { timeout: 250 });
    }
  }).toPass({ timeout: 15_000 });
}

/**
 * Choose from a set of `<select>`s and prove the choices survived hydration.
 *
 * The same hazard `fillForm` exists for, on a control `fill()` cannot touch. A
 * controlled `<select>` set between the HTML arriving and React hydrating takes
 * the raw DOM value and dispatches a `change` nobody is listening to yet;
 * component state never moves, and the first controlled render puts the old
 * option back.
 *
 * The symptom is *worse* than an empty field. Nothing errors — the form submits
 * plausible values from a rule nobody chose — so the assertion that fails is
 * several steps later, about data that was written perfectly correctly. That is
 * a long way to walk back from.
 *
 * `AGENTS.md` states the rule as "never a bare `fill()`". This is the same rule;
 * `<select>` just has a different verb.
 */
export async function selectForm(
  fields: Array<readonly [Locator, string]>,
): Promise<void> {
  await expect(async () => {
    for (const [field, value] of fields) {
      await field.selectOption(value);
    }
    for (const [field, value] of fields) {
      await expect(field).toHaveValue(value, { timeout: 250 });
    }
  }).toPass({ timeout: 15_000 });
}

/** Sign in through the real form. Leaves navigation to the caller to assert. */
export async function signIn(
  page: Page,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<void> {
  await page.goto("/sign-in");

  await fillForm([
    [page.getByLabel(/^email$/i), email],
    [page.getByLabel(/^password$/i), password],
  ]);

  await page.getByRole("button", { name: /sign in/i }).click();
}
