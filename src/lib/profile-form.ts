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

/** True for a zone the server-side validator will also accept. */
export function isKnownTimeZone(value: string): boolean {
  return KNOWN_TIME_ZONES.has(value);
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
 * A stored zone the user actually chose always wins. Only the untouched
 * default (`UTC`, written by the schema, not by a person) is replaced with the
 * browser's own zone — and only when that zone is one the server will accept,
 * because some browsers still report aliases such as "Asia/Calcutta" that
 * `supportedValuesOf` does not list. Prefilling is a *suggestion*: nothing is
 * written until the form is submitted.
 */
export function resolveInitialTimeZone(
  stored: string | null | undefined,
  detected: string | null = detectTimeZone(),
): string {
  if (stored && stored !== UTC) return stored;
  if (detected && detected !== UTC && isKnownTimeZone(detected)) return detected;
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
