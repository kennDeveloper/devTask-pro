/**
 * The rules behind the settings form, as pure functions.
 *
 * Nothing here imports React, Next or the database — the settings screen is a
 * thin renderer over these, exactly as the auth pages are over
 * `src/lib/auth/validators.ts`. That is what makes "does the current timezone
 * appear in the option list" a unit test rather than a click-through.
 *
 * The authority for what may be *saved* is `profileUpdateInput` in
 * `src/lib/trpc/routers/profile.ts`, and behind it the `profiles_update_own`
 * policy. This module deliberately mirrors that rule instead of importing it:
 * that router pulls in `withUser` → `postgres`, which must never be dragged
 * into the browser bundle. The mirror is asserted, not assumed — see
 * `profile-form.test.ts`.
 */

/**
 * The zone `profiles.timezone` defaults to (migration 0001), and the reason
 * this file exists.
 *
 * `Intl.supportedValuesOf("timeZone")` returns **canonical** IANA identifiers
 * only and drops every link/alias, so it does not contain "UTC" — verified on
 * Node 22: 418 zones, none of them "UTC". Build a `<select>` from that list
 * alone and a brand-new account, whose stored zone is exactly "UTC", renders
 * with nothing selected; saving then writes whatever happened to be first in
 * the list. Adding the alias back by hand is the whole fix, and it is the same
 * one the server-side validator makes.
 */
export const UTC = "UTC";

/** Matches `profileUpdateInput.displayName`'s `.max(80)`. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/** The exact strings the form renders. Tests assert against these. */
export const PROFILE_FORM_MESSAGES = {
  displayNameRequired: "Enter a display name.",
  displayNameTooLong: `Use ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
  timezoneUnknown: "Choose a time zone from the list.",
} as const;

/**
 * Computed once at module load — `supportedValuesOf` allocates a ~420-entry
 * array on every call and the answer cannot change while the tab is open.
 */
const KNOWN_TIME_ZONES: ReadonlySet<string> = new Set([
  ...Intl.supportedValuesOf("timeZone"),
  UTC,
]);

/**
 * The canonical spelling of `value` on this runtime, or `null` if it is not a
 * zone we will persist.
 *
 * ---------------------------------------------------------------------------
 * WHY A SET MEMBERSHIP TEST IS NOT ENOUGH — this rejected real users
 * ---------------------------------------------------------------------------
 * `Intl.supportedValuesOf("timeZone")` does not enumerate the same spellings on
 * every engine. On this project's Node 22 / ICU 77 it lists the **legacy** names
 * and omits the modern ones:
 *
 *     Asia/Calcutta   listed        Asia/Kolkata               NOT listed
 *     Europe/Kiev     listed        Europe/Kyiv                NOT listed
 *     Asia/Saigon     listed        Asia/Ho_Chi_Minh           NOT listed
 *
 * Browsers that have shipped the ECMA-402 time-zone-canonicalization change
 * report the opposite. So a plain `KNOWN_TIME_ZONES.has(value)` gives *different
 * answers on the server and in the browser*: a user in India whose browser
 * reports "Asia/Kolkata" passed the client check and was then rejected by the
 * server, leaving a settings form that could not be submitted. Both spellings
 * name the same zone and format identically, because the engines share one tz
 * database even when they disagree about which names to enumerate.
 *
 * So: consult the list first (fast, and the common case), and only on a miss ask
 * the tz database itself to resolve the name. Anything it resolves to a zone in
 * the list is real, and the **canonical** spelling is what gets returned — so
 * that is what callers store.
 *
 * This deliberately keeps the original rule's *goal* while changing its
 * mechanism. Phase 1 rejected offsets and aliases because neither is "an IANA
 * zone we want persisted". Normalising achieves that more completely than
 * rejecting did: `+10:00` resolves to `+10:00`, which is not in the list, so it
 * is still refused — while `US/Eastern` is stored as `America/New_York` rather
 * than bounced. Nothing non-canonical reaches the column either way.
 */
export function canonicalTimeZone(value: string): string | null {
  if (KNOWN_TIME_ZONES.has(value)) return value;

  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    // RangeError: not a name this runtime's tz database knows at all.
    return null;
  }

  return KNOWN_TIME_ZONES.has(resolved) ? resolved : null;
}

/** True for a zone the server-side validator will also accept. */
export function isKnownTimeZone(value: string): boolean {
  return canonicalTimeZone(value) !== null;
}

/**
 * The `<option>` list, with `UTC` pinned first.
 *
 * Every value passed in `include` is guaranteed to appear, even if this
 * runtime does not recognise it. A stored zone that has since been retired
 * from the tz database would otherwise vanish from the list and leave the
 * control showing a value the user never chose.
 */
export function timeZoneOptions(
  ...include: Array<string | null | undefined>
): string[] {
  const zones = new Set(KNOWN_TIME_ZONES);
  for (const zone of include) {
    if (zone) zones.add(zone);
  }
  return [
    UTC,
    ...[...zones]
      .filter((zone) => zone !== UTC)
      .sort((a, b) => a.localeCompare(b)),
  ];
}

/** This browser's zone, or `null` where `Intl` cannot say. */
export function detectTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * What the timezone control should start on.
 *
 * A stored zone the user actually chose always wins. Only the untouched default
 * (`UTC`, written by the schema, not by a person) is replaced with the browser's
 * own zone.
 *
 * The detected zone is **canonicalised**, not just checked. Engines disagree
 * about which spelling of a zone to report — a browser may say "Asia/Kolkata"
 * where this runtime lists "Asia/Calcutta" — and prefilling the browser's
 * spelling would show the user one name in the control and then store a
 * different one, so the field appears to change by itself on the next load.
 * Returning the canonical name makes what is displayed and what is written the
 * same string.
 *
 * (An earlier version of this comment had the direction of that disagreement
 * backwards, claiming browsers report aliases like "Asia/Calcutta" that
 * `supportedValuesOf` omits. On this runtime "Asia/Calcutta" is precisely what
 * the list *does* contain. See `canonicalTimeZone`.)
 *
 * Prefilling is a *suggestion*: nothing is written until the form is submitted.
 */
export function resolveInitialTimeZone(
  stored: string | null | undefined,
  detected: string | null = detectTimeZone(),
): string {
  if (stored && stored !== UTC) return stored;

  if (detected && detected !== UTC) {
    const canonical = canonicalTimeZone(detected);
    if (canonical && canonical !== UTC) return canonical;
  }

  return stored || UTC;
}

export interface ProfileFormValues {
  displayName: string;
  timezone: string;
}

/** One message per field — the shape `<Field error>` consumes directly. */
export type ProfileFormErrors = Partial<
  Record<keyof ProfileFormValues, string>
>;

export type ProfileFormResult =
  | { ok: true; data: ProfileFormValues }
  | { ok: false; errors: ProfileFormErrors };

/**
 * Mirrors `profileUpdateInput`. The client copy exists to produce a message
 * under the right control before a round trip; the server copy is the boundary.
 */
export function validateProfileForm(
  values: ProfileFormValues,
): ProfileFormResult {
  const errors: ProfileFormErrors = {};
  const displayName = values.displayName.trim();

  if (displayName.length === 0) {
    errors.displayName = PROFILE_FORM_MESSAGES.displayNameRequired;
  } else if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    errors.displayName = PROFILE_FORM_MESSAGES.displayNameTooLong;
  }

  if (!isKnownTimeZone(values.timezone)) {
    errors.timezone = PROFILE_FORM_MESSAGES.timezoneUnknown;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, data: { displayName, timezone: values.timezone } };
}

/**
 * What to call someone in the chrome.
 *
 * `display_name` is nullable and stays null until the account holder sets one,
 * so the shell needs a fallback that is recognisably them rather than a blank
 * space or a uuid. The local part of the email is the least surprising choice —
 * and because the settings form seeds its field with the same value, saving
 * simply adopts what the user was already being shown.
 */
export function profileDisplayName(
  displayName: string | null | undefined,
  email: string,
): string {
  const trimmed = displayName?.trim();
  if (trimmed) return trimmed;
  const localPart = email.replace(/@.*/, "").trim();
  return localPart || email;
}

/** Up to two letters for the avatar, derived from whatever name we have. */
export function profileInitials(name: string, email: string): string {
  const base = (name || email).replace(/@.*/, "");
  const parts = base.split(/[\s._-]+/).filter(Boolean).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || "·";
}

/** Human labels for the two columns the account holder cannot change. */
export const ACCOUNT_ROLE_LABELS: Record<string, string> = {
  member: "Member",
  admin: "Administrator",
};

export const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  pending: "Awaiting approval",
  active: "Active",
  rejected: "Rejected",
  suspended: "Suspended",
};

export function accountRoleLabel(role: string): string {
  return ACCOUNT_ROLE_LABELS[role] ?? role;
}

export function accountStatusLabel(status: string): string {
  return ACCOUNT_STATUS_LABELS[status] ?? status;
}
