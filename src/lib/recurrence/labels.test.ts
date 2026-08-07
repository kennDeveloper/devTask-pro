import { describe, expect, it } from "vitest";

import { RECURRENCE_FREQUENCIES, WEEKDAYS } from "@/lib/db/schema";

import {
  describeRule,
  ENDS_MODE_OPTIONS,
  FREQUENCY_OPTIONS,
  intervalUnitLabel,
  MONTH_MODE_OPTIONS,
  NTH_WEEK_OPTIONS,
  WEEKDAY_OPTIONS,
} from "./labels";
import { normaliseRule, type RecurrenceRule } from "./rule";

/**
 * The words. `describeRule` is shared between the editor's preview and the
 * repeat button in the list, so a change here shows up in two places at once —
 * which is the point: two copies would eventually describe the same rule two
 * different ways on one screen.
 */

function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule {
  return normaliseRule({
    freq: "daily",
    interval: 1,
    byweekday: [],
    monthMode: null,
    monthDay: null,
    nthWeek: null,
    nthWeekday: null,
    endsMode: "never",
    endsOn: null,
    endsCount: null,
    ...overrides,
  });
}

describe("intervalUnitLabel", () => {
  it("is singular at 1 and plural above it", () => {
    // "Every 1 weeks" survives whole releases because everybody reads past it.
    expect(intervalUnitLabel("weekly", 1)).toBe("week");
    expect(intervalUnitLabel("weekly", 2)).toBe("weeks");
    expect(intervalUnitLabel("daily", 1)).toBe("day");
    expect(intervalUnitLabel("yearly", 5)).toBe("years");
  });
});

describe("describeRule", () => {
  it.each([
    ["Every day", rule({ freq: "daily" })],
    ["Every 3 days", rule({ freq: "daily", interval: 3 })],
    [
      "Every 2 weeks on Mon, Wed",
      rule({ freq: "weekly", interval: 2, byweekday: ["MO", "WE"] }),
    ],
    [
      "Every month on day 15",
      rule({ freq: "monthly", monthMode: "by_date", monthDay: 15 }),
    ],
    [
      "Every month on the last Friday",
      rule({
        freq: "monthly",
        monthMode: "by_nth_weekday",
        nthWeek: -1,
        nthWeekday: "FR",
      }),
    ],
    [
      "Every 2 months on the second Tuesday",
      rule({
        freq: "monthly",
        interval: 2,
        monthMode: "by_nth_weekday",
        nthWeek: 2,
        nthWeekday: "TU",
      }),
    ],
    ["Every year", rule({ freq: "yearly" })],
  ])("reads as %s", (expected, value) => {
    expect(describeRule(value)).toBe(expected);
  });

  it("appends the ending, and gets the plural right at one", () => {
    expect(describeRule(rule({ endsMode: "after", endsCount: 10 }))).toBe(
      "Every day, 10 times",
    );
    expect(describeRule(rule({ endsMode: "after", endsCount: 1 }))).toBe(
      "Every day, 1 time",
    );
  });

  it("renders the until date in the app's pinned format, not as raw ISO", () => {
    expect(describeRule(rule({ endsMode: "on", endsOn: "2026-12-31" }))).toBe(
      "Every day, until 31 Dec 2026",
    );
  });

  it("is never the RRULE string", () => {
    // `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` is the interchange format and means
    // nothing to the person who wrote the rule. It belongs in the column.
    expect(
      describeRule(rule({ freq: "weekly", interval: 2, byweekday: ["MO"] })),
    ).not.toMatch(/FREQ=/);
  });

  it("says something for every frequency, however incomplete the rule", () => {
    for (const freq of RECURRENCE_FREQUENCIES) {
      expect(describeRule(rule({ freq }))).not.toBe("");
    }
  });
});

describe("the option lists are derived, not written out", () => {
  it("offers every frequency and every weekday", () => {
    expect(FREQUENCY_OPTIONS.map((o) => o.value)).toEqual([
      ...RECURRENCE_FREQUENCIES,
    ]);
    expect(WEEKDAY_OPTIONS.map((o) => o.value)).toEqual([...WEEKDAYS]);
  });

  it("labels every option — a missing entry would render `undefined`", () => {
    for (const option of [
      ...FREQUENCY_OPTIONS,
      ...MONTH_MODE_OPTIONS,
      ...ENDS_MODE_OPTIONS,
      ...NTH_WEEK_OPTIONS,
      ...WEEKDAY_OPTIONS,
    ]) {
      expect(option.label).toBeTruthy();
    }
  });

  it("offers Last among the nth-week options", () => {
    expect(NTH_WEEK_OPTIONS.map((o) => o.value)).toContain(-1);
    expect(NTH_WEEK_OPTIONS.find((o) => o.value === -1)?.label).toBe("Last");
  });
});
