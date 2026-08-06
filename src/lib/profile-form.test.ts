import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_MAX_LENGTH,
  PROFILE_FORM_MESSAGES,
  UTC,
  accountStatusLabel,
  canonicalTimeZone,
  isKnownTimeZone,
  profileDisplayName,
  profileInitials,
  resolveInitialTimeZone,
  timeZoneOptions,
  validateProfileForm,
} from "./profile-form";

describe("time zone options", () => {
  /**
   * The regression guard for the bug this module was written around. If a
   * future runtime starts listing "UTC" as canonical, this fails — and whoever
   * is looking at it can then decide whether the hand-added alias is still
   * needed, rather than discovering the answer through a broken settings form.
   */
  it("Intl.supportedValuesOf omits UTC, which is why we add it", () => {
    expect(Intl.supportedValuesOf("timeZone")).not.toContain(UTC);
    expect(isKnownTimeZone(UTC)).toBe(true);
  });

  it("pins UTC first so the schema default is never the odd one out", () => {
    expect(timeZoneOptions()[0]).toBe(UTC);
  });

  it("lists real zones", () => {
    const options = timeZoneOptions();
    expect(options).toContain("Australia/Sydney");
    expect(options).toContain("Europe/London");
    expect(options.length).toBeGreaterThan(100);
  });

  it("always includes the values it is asked to include, known or not", () => {
    const options = timeZoneOptions("Mars/Olympus_Mons", null, undefined);
    expect(options).toContain("Mars/Olympus_Mons");
    // ...and does not duplicate one it already had.
    expect(
      timeZoneOptions("Europe/London").filter((z) => z === "Europe/London"),
    ).toHaveLength(1);
  });

  it("rejects offsets and names the tz database does not know", () => {
    expect(isKnownTimeZone("+10:00")).toBe(false);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
    expect(canonicalTimeZone("+10:00")).toBeNull();
    expect(canonicalTimeZone("Australia/Sidney")).toBeNull();
  });

  /**
   * The regression guard for a defect that reached main in phase 1.
   *
   * `supportedValuesOf` enumerates different spellings on different engines — on
   * this Node it lists the legacy names and omits the modern ones, while
   * canonicalising browsers do the reverse. Both name the same zone. A plain set
   * membership test therefore disagreed across the wire, and a user whose browser
   * reported "Asia/Kolkata" could not save their settings at all.
   *
   * If a future runtime starts listing the modern spellings directly, these still
   * pass — `canonicalTimeZone` returns the value unchanged when it is already in
   * the list.
   */
  it("accepts a zone this runtime spells differently, and canonicalises it", () => {
    const modern = ["Asia/Kolkata", "Europe/Kyiv", "Asia/Ho_Chi_Minh"];

    for (const zone of modern) {
      expect(isKnownTimeZone(zone)).toBe(true);

      const canonical = canonicalTimeZone(zone);
      expect(canonical).not.toBeNull();
      // Whatever the spelling in, what comes out is a name this runtime lists —
      // which is what makes it safe to write to profiles.timezone.
      expect(timeZoneOptions()).toContain(canonical);
    }
  });

  /**
   * Legacy aliases are normalised rather than refused. Phase 1 rejected them
   * because neither an offset nor an alias is "an IANA zone we want persisted";
   * normalising serves that goal more completely, since the column ends up with
   * the canonical name instead of the request being bounced.
   */
  it("normalises a legacy alias instead of rejecting it", () => {
    expect(canonicalTimeZone("US/Eastern")).toBe("America/New_York");
  });
});

describe("resolveInitialTimeZone", () => {
  it("keeps a zone the user actually chose", () => {
    expect(resolveInitialTimeZone("Europe/London", "Australia/Sydney")).toBe(
      "Europe/London",
    );
  });

  it("replaces the untouched UTC default with the browser's zone", () => {
    expect(resolveInitialTimeZone(UTC, "Australia/Sydney")).toBe(
      "Australia/Sydney",
    );
  });

  it("ignores a browser zone the server would reject", () => {
    // A name no tz database knows. `US/Eastern` used to stand here, but it is a
    // real zone under an old spelling and is now normalised rather than refused
    // — using it would have made this a test of alias handling, not of garbage.
    expect(resolveInitialTimeZone(UTC, "Mars/Olympus_Mons")).toBe(UTC);
    expect(resolveInitialTimeZone(UTC, "+10:00")).toBe(UTC);
    expect(resolveInitialTimeZone(UTC, null)).toBe(UTC);
  });

  /**
   * The control must show the same string that will end up in the column.
   * Otherwise a user in India sees "Asia/Kolkata", saves, and finds the field
   * reading "Asia/Calcutta" next time — which looks like the app changed their
   * setting behind their back.
   */
  it("canonicalises the detected zone so display and storage agree", () => {
    expect(resolveInitialTimeZone(UTC, "Asia/Kolkata")).toBe(
      canonicalTimeZone("Asia/Kolkata"),
    );
    expect(timeZoneOptions()).toContain(resolveInitialTimeZone(UTC, "Asia/Kolkata"));
  });

  it("falls back to UTC when there is no stored value at all", () => {
    expect(resolveInitialTimeZone(null, null)).toBe(UTC);
  });
});

describe("validateProfileForm", () => {
  it("accepts a filled form and trims the name", () => {
    const result = validateProfileForm({
      displayName: "  Ada Lovelace  ",
      timezone: "Europe/London",
    });
    expect(result).toEqual({
      ok: true,
      data: { displayName: "Ada Lovelace", timezone: "Europe/London" },
    });
  });

  it("accepts UTC — the value the database itself writes", () => {
    const result = validateProfileForm({ displayName: "Ada", timezone: UTC });
    expect(result.ok).toBe(true);
  });

  it("rejects a blank name", () => {
    const result = validateProfileForm({ displayName: "   ", timezone: UTC });
    expect(result).toEqual({
      ok: false,
      errors: { displayName: PROFILE_FORM_MESSAGES.displayNameRequired },
    });
  });

  it("rejects an over-long name", () => {
    const result = validateProfileForm({
      displayName: "a".repeat(DISPLAY_NAME_MAX_LENGTH + 1),
      timezone: UTC,
    });
    expect(result).toEqual({
      ok: false,
      errors: { displayName: PROFILE_FORM_MESSAGES.displayNameTooLong },
    });
  });

  it("rejects an unknown zone", () => {
    const result = validateProfileForm({
      displayName: "Ada",
      timezone: "+10:00",
    });
    expect(result).toEqual({
      ok: false,
      errors: { timezone: PROFILE_FORM_MESSAGES.timezoneUnknown },
    });
  });
});

describe("profile display helpers", () => {
  it("prefers a set display name", () => {
    expect(profileDisplayName("Ada", "ada@example.com")).toBe("Ada");
  });

  it("falls back to the email local part", () => {
    expect(profileDisplayName(null, "ada.lovelace@example.com")).toBe(
      "ada.lovelace",
    );
    expect(profileDisplayName("   ", "ada@example.com")).toBe("ada");
  });

  it("derives up to two initials", () => {
    expect(profileInitials("Ada Lovelace", "ada@example.com")).toBe("AL");
    expect(profileInitials("", "ada.lovelace@example.com")).toBe("AL");
    expect(profileInitials("", "@example.com")).toBe("·");
  });

  it("labels statuses in words, and passes unknown ones through", () => {
    expect(accountStatusLabel("pending")).toBe("Awaiting approval");
    expect(accountStatusLabel("something-new")).toBe("something-new");
  });
});
