import { describe, expect, it } from "vitest";

import {
  REMINDER_CADENCE_MINUTES,
  REMINDER_LEAD_MAX,
  REMINDER_LEAD_MIN,
  REMINDER_PRESETS,
  isReminderLead,
  reminderLeadLabel,
} from "./reminder-lead";

describe("the bounds mirror the check constraint", () => {
  it("accepts both ends inclusively", () => {
    expect(isReminderLead(REMINDER_LEAD_MIN)).toBe(true);
    expect(isReminderLead(REMINDER_LEAD_MAX)).toBe(true);
  });

  it("rejects either side of them", () => {
    expect(isReminderLead(REMINDER_LEAD_MIN - 1)).toBe(false);
    expect(isReminderLead(REMINDER_LEAD_MAX + 1)).toBe(false);
  });

  it("rejects a fraction, because the column is an integer", () => {
    // 42.5 would be silently rounded by the driver and read back as a value
    // nobody chose — the same reasoning `isProgress` documents.
    expect(isReminderLead(42.5)).toBe(false);
  });

  it("is one week, matching 0005 and 0007", () => {
    expect(REMINDER_LEAD_MAX).toBe(7 * 24 * 60);
  });
});

describe("the presets", () => {
  it("offers no reminder first, as the default and the way out", () => {
    expect(REMINDER_PRESETS[0].value).toBeNull();
  });

  it("only offers leads the column would accept", () => {
    for (const preset of REMINDER_PRESETS) {
      if (preset.value !== null) expect(isReminderLead(preset.value)).toBe(true);
    }
  });

  /**
   * The job sends inside `[deadline − lead, deadline)` and the cron ticks every
   * `REMINDER_CADENCE_MINUTES`. A lead shorter than the cadence gives the job a
   * window it can step straight over, so the reminder would fire or not
   * depending on where the tick landed. Two runs inside the shortest window is
   * the margin, and this is the test that notices if somebody adds a 1-minute
   * preset or slows the cron down.
   */
  it("keeps the shortest lead at least twice the cron cadence", () => {
    const shortest = Math.min(
      ...REMINDER_PRESETS.flatMap((preset) =>
        preset.value === null ? [] : [preset.value],
      ),
    );

    expect(shortest).toBeGreaterThanOrEqual(REMINDER_CADENCE_MINUTES * 2);
  });

  it("rises, so the menu reads in order", () => {
    const values = REMINDER_PRESETS.flatMap((preset) =>
      preset.value === null ? [] : [preset.value],
    );

    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });
});

describe("reminderLeadLabel", () => {
  it("uses the preset wording when there is one", () => {
    expect(reminderLeadLabel(null)).toBe("No reminder");
    expect(reminderLeadLabel(60)).toBe("1 hour before");
  });

  it("still renders a lead no preset offers", () => {
    // A value written through the API, or one a future shorter cadence allows.
    // A control that dropped it would silently show the wrong reminder.
    expect(reminderLeadLabel(45)).toBe("45 minutes before");
    expect(reminderLeadLabel(1)).toBe("1 minute before");
  });
});
