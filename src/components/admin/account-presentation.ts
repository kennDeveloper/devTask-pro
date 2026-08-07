/**
 * How an account *reads* — the column list, the status pill's tone, the date
 * strings, and the one template that names every action control.
 *
 * Pure functions only, no React. It sits beside the components rather than in
 * `src/lib/admin/` because it is *presentation*: `src/lib/admin/transitions.ts`
 * owns the product rules (which actions exist, which are legal, which are
 * destructive), and this file owns how those answers are spelled on a screen.
 * Nothing here decides anything.
 *
 * ## Every formatter takes an explicit locale and zone. None reads the ambient ones.
 *
 * `new Intl.DateTimeFormat()` with no arguments uses the *host's* locale and
 * timezone, which is a different host on the server than in the browser — a
 * hydration error caused entirely by a date string. Both are pinned here.
 *
 * **UTC is the right zone for this screen, and it is a decision rather than a
 * default.** Everywhere else in devtask-pro a date is rendered in the *account
 * holder's* zone, because it is their day and their deadline. These dates are
 * not the account holder's: they are audit facts about when a row was created
 * and when somebody last signed in, read by an administrator who may share a
 * zone with none of them. Rendering each row in a different zone would make the
 * column unsortable by eye. The suffix says which zone, so nobody has to guess.
 */

import {
  ADMIN_ACTION_SPECS,
  type AdminAction,
} from "@/lib/admin/transitions";
import type { BadgeTone } from "@/components/ui/badge";
import type { ProfileStatus } from "@/lib/db/schema";

/** Pinned so the server and the browser produce byte-identical strings. */
const LOCALE = "en-GB";

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type AccountColumnKey =
  | "account"
  | "status"
  | "signedUp"
  | "lastSignIn"
  | "actions";

export interface AccountColumn {
  key: AccountColumnKey;
  label: string;
  /** True when the header is for screen readers only (an actions column). */
  labelHidden?: boolean;
  /** Width class for the matching skeleton cell, so loading mirrors loaded. */
  skeletonWidth: string;
  /** Applied to both the header cell and the skeleton cell. */
  className?: string;
}

/**
 * The table's columns, as data.
 *
 * Written once and consumed by the header, the skeleton and the empty row's
 * `colSpan` — the alternative is a hand-counted `colSpan={5}` next to a
 * hand-written header, which is a column added in one place and a mis-spanned
 * empty state in another.
 *
 * There is no sixth column, and the one that is missing is the point: **no task
 * count, no "3 open" figure, nothing derived from task data.** Adding one would
 * need a query the repo deliberately cannot compose (see the banner in
 * `src/lib/db/repos/profiles.ts`) and would undo the guarantee criterion 6
 * exists to give.
 */
export const ACCOUNT_COLUMNS: readonly AccountColumn[] = [
  { key: "account", label: "Account", skeletonWidth: "w-56" },
  { key: "status", label: "Status", skeletonWidth: "w-24" },
  { key: "signedUp", label: "Signed up", skeletonWidth: "w-28" },
  { key: "lastSignIn", label: "Last sign-in", skeletonWidth: "w-32" },
  {
    key: "actions",
    label: "Actions",
    labelHidden: true,
    skeletonWidth: "w-40",
    className: "text-right",
  },
];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The pill's colour, per status.
 *
 * `warning` for pending because it is the one that wants the admin's attention —
 * somebody is waiting. `danger` for rejected and `neutral` for suspended, which
 * is the one visual difference between two states the *user* is deliberately not
 * told apart (both see /no-access, with no explanation of which). The admin is
 * told, because "has this person ever had access?" changes what reinstating
 * them means.
 */
export const ACCOUNT_STATUS_TONES: Record<ProfileStatus, BadgeTone> = {
  pending: "warning",
  active: "success",
  rejected: "danger",
  suspended: "neutral",
};

export function accountStatusTone(status: ProfileStatus): BadgeTone {
  return ACCOUNT_STATUS_TONES[status] ?? "default";
}

/**
 * The words on the pill.
 *
 * Deliberately **not** `accountStatusLabel` from `profile-form.ts`. That one
 * says "Awaiting approval" for pending, which is written for the account holder
 * looking at their own settings page. The admin is the person the account is
 * awaiting, so the same word from their side is just "Pending" — the queue they
 * are working, not a status being explained to them.
 */
export const ACCOUNT_STATUS_LABELS: Record<ProfileStatus, string> = {
  pending: "Pending",
  active: "Active",
  rejected: "Rejected",
  suspended: "Suspended",
};

export function accountStatusLabel(status: string): string {
  return ACCOUNT_STATUS_LABELS[status as ProfileStatus] ?? status;
}

// ---------------------------------------------------------------------------
// Control names — the one template, defined once
// ---------------------------------------------------------------------------

/**
 * The accessible name of an action control: `"Approve ada@example.com"`.
 *
 * ## Why this is a function and not two string literals
 *
 * AGENTS.md: every list renders **both** presentations at once — a `<Table>` in
 * `hidden md:block` and a card stack in `md:hidden` — so each account's controls
 * exist twice in the DOM with exactly one copy displayed. Playwright's role
 * engine resolves to whichever is visible, so one `getByRole` line covers both
 * projects. That only works while the two spell their names identically, and
 * AGENTS.md records that keeping `task-row.tsx` and `task-card.tsx` in step is a
 * manual discipline whose failure is a silent e2e break on one project only.
 *
 * Here it is not manual. The row and the card both render the same
 * `<AccountActions>` component, which calls this function — so there is exactly
 * one place the name is spelled and drift is impossible rather than forbidden.
 *
 * The **email** is the identifier rather than the display name, because a
 * display name is optional and two people may share one. Every row's controls
 * must be uniquely addressable or Playwright's strict mode fails.
 */
export function actionControlName(action: AdminAction, email: string): string {
  return `${ADMIN_ACTION_SPECS[action].label} ${email}`;
}

/** The reset control's name, on the same template. */
export const RESET_PASSWORD_LABEL = "Send password reset";

export function resetControlName(email: string): string {
  return `${RESET_PASSWORD_LABEL} to ${email}`;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(LOCALE, {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  // "h23" rather than `hour12: false` — some ICU builds render midnight as
  // "24:00" under the latter. Same note as `task-presentation.ts`.
  hourCycle: "h23",
});

/** `"2026-08-06T09:30:00.000Z"` → `"6 Aug 2026"`. */
export function formatSignupDate(iso: string): string {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return DATE_FORMAT.format(instant);
}

/**
 * `"2026-08-06T09:30:00.000Z"` → `"6 Aug 2026, 09:30 UTC"`, and `null` →
 * `"Never"`.
 *
 * "Never" is a real answer and worth saying plainly: an account that has been
 * approved but never signed in is a different thing from one that signed in last
 * week, and an em dash would leave the admin guessing which.
 */
export const NEVER_SIGNED_IN = "Never";

export function formatLastSignIn(iso: string | null): string {
  if (!iso) return NEVER_SIGNED_IN;
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return iso;
  return `${DATE_TIME_FORMAT.format(instant)} UTC`;
}

/**
 * What to call an account in the list.
 *
 * The email is the identity here — it is what the admin was given, what the
 * signup arrived as, and what is unique. A display name is shown underneath when
 * there is one, and is never substituted for the address.
 */
export function accountSecondaryLine(displayName: string | null): string | null {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : null;
}
