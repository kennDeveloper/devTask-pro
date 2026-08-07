import { describe, expect, it } from "vitest";

import { REMINDER_PRESETS } from "@/lib/tasks/reminder-lead";

import { optionsFor } from "./reminder-select";

/**
 * The one thing this control decides for itself: what to do with a stored value
 * the preset menu does not contain.
 *
 * The presets are the *menu*, not the constraint — the column accepts anything
 * from 0 to a week, and `taskReminderLeadField` mirrors that rather than the
 * menu. So a lead of 45 minutes is a legitimate value a `<select>` would
 * otherwise be unable to display, and a control that silently fell back to the
 * nearest option would show the user a reminder they never set and write it back
 * on the next save.
 */

describe("optionsFor", () => {
  it("is exactly the presets for a value that is one of them", () => {
    expect(optionsFor(30)).toBe(REMINDER_PRESETS);
    expect(optionsFor(null)).toBe(REMINDER_PRESETS);
  });

  it("adds a value the presets do not offer, rather than dropping it", () => {
    const options = optionsFor(45);

    expect(options.map((option) => option.value)).toContain(45);
    expect(options.find((option) => option.value === 45)?.label).toBe(
      "45 minutes before",
    );
  });

  it("keeps the menu reading shortest to longest", () => {
    const leads = optionsFor(45)
      .map((option) => option.value)
      .filter((value): value is number => value !== null);

    expect([...leads].sort((a, b) => a - b)).toEqual(leads);
  });

  it("keeps 'no reminder' first, however the rest sorts", () => {
    // It is the default and the way back out; sorting it by value would bury it
    // among the leads or, worse, treat its null as a zero.
    expect(optionsFor(45)[0].value).toBeNull();
    expect(optionsFor(1)[0].value).toBeNull();
  });

  it("adds exactly one entry and keeps every preset", () => {
    const options = optionsFor(45);

    expect(options).toHaveLength(REMINDER_PRESETS.length + 1);
    for (const preset of REMINDER_PRESETS) {
      expect(options.map((option) => option.value)).toContain(preset.value);
    }
  });
});
