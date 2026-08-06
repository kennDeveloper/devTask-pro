import { describe, expect, it } from "vitest";

import {
  DISPLAY_NAME_MAX_LENGTH,
  PROFILE_FORM_MESSAGES,
  UTC,
  accountStatusLabel,
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

  it("rejects offsets and legacy aliases", () => {
    expect(isKnownTimeZone("+10:00")).toBe(false);
    expect(isKnownTimeZone("US/Eastern")).toBe(false);
    expect(isKnownTimeZone("Not/AZone")).toBe(false);
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
    expect(resolveInitialTimeZone(UTC, "US/Eastern")).toBe(UTC);
    expect(resolveInitialTimeZone(UTC, null)).toBe(UTC);
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
