import { describe, expect, it } from "vitest";

import {
  defaultRule,
  normaliseRule,
  rulesEqual,
  sortWeekdays,
  type RecurrenceRule,
} from "./rule";

/**
 * `normaliseRule` is the polite half of the six cross-column CHECKs in
 * `0005_task_series.sql`. The database refuses a monthly series carrying
 * weekdays; this is what stops a user who changed their mind in the editor from
 * meeting that refusal.
 */

function rule(overrides: Partial<RecurrenceRule> = {}): RecurrenceRule {
  return {
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
  };
}

describe("normaliseRule clears what the frequency does not use", () => {
  it("drops weekdays when the rule is not weekly", () => {
    // The editor's state still holds them after switching Weekly → Monthly, and
    // `task_series_weekly_days_check` would reject the row.
    expect(
      normaliseRule(
        rule({
          freq: "monthly",
          byweekday: ["MO", "WE"],
          monthMode: "by_date",
          monthDay: 15,
        }),
      ).byweekday,
    ).toEqual([]);
  });

  it("drops the monthly fields when the rule is not monthly", () => {
    const normalised = normaliseRule(
      rule({
        freq: "weekly",
        byweekday: ["MO"],
        monthMode: "by_date",
        monthDay: 15,
        nthWeek: -1,
        nthWeekday: "FR",
      }),
    );
    expect(normalised.monthMode).toBeNull();
    expect(normalised.monthDay).toBeNull();
    expect(normalised.nthWeek).toBeNull();
    expect(normalised.nthWeekday).toBeNull();
  });

  it("keeps only the fields the chosen monthly mode uses", () => {
    const byDate = normaliseRule(
      rule({
        freq: "monthly",
        monthMode: "by_date",
        monthDay: 15,
        nthWeek: 2,
        nthWeekday: "TU",
      }),
    );
    expect(byDate.monthDay).toBe(15);
    expect(byDate.nthWeek).toBeNull();
    expect(byDate.nthWeekday).toBeNull();

    const byNth = normaliseRule(
      rule({
        freq: "monthly",
        monthMode: "by_nth_weekday",
        monthDay: 15,
        nthWeek: 2,
        nthWeekday: "TU",
      }),
    );
    expect(byNth.monthDay).toBeNull();
    expect(byNth.nthWeek).toBe(2);
  });

  it("clears the end fields the chosen mode does not use", () => {
    const never = normaliseRule(
      rule({ endsMode: "never", endsOn: "2026-12-31", endsCount: 10 }),
    );
    expect(never.endsOn).toBeNull();
    expect(never.endsCount).toBeNull();

    const on = normaliseRule(
      rule({ endsMode: "on", endsOn: "2026-12-31", endsCount: 10 }),
    );
    expect(on.endsOn).toBe("2026-12-31");
    expect(on.endsCount).toBeNull();

    const after = normaliseRule(
      rule({ endsMode: "after", endsOn: "2026-12-31", endsCount: 10 }),
    );
    expect(after.endsOn).toBeNull();
    expect(after.endsCount).toBe(10);
  });

  it("defaults a monthly rule with no mode to by_date rather than to an invalid row", () => {
    expect(normaliseRule(rule({ freq: "monthly" })).monthMode).toBe("by_date");
  });

  it.each([
    [0, 1],
    [-3, 1],
    [2.7, 2],
    [Number.NaN, 1],
  ])("forces interval %s to %i", (given, expected) => {
    expect(normaliseRule(rule({ interval: given })).interval).toBe(expected);
  });

  it("sorts and de-duplicates weekdays, so one rule has one spelling", () => {
    expect(
      normaliseRule(
        rule({ freq: "weekly", byweekday: ["WE", "MO", "WE"] }),
      ).byweekday,
    ).toEqual(["MO", "WE"]);
  });
});

describe("sortWeekdays", () => {
  it("puts Monday first, per RFC 5545's default WKST", () => {
    expect(sortWeekdays(["SU", "SA", "MO"])).toEqual(["MO", "SA", "SU"]);
  });
});

describe("defaultRule", () => {
  it("names a real day straight away, seeded from the start date", () => {
    // A weekly rule with no weekdays would render an editor describing nothing.
    expect(defaultRule("2026-01-07")).toMatchObject({
      freq: "weekly",
      interval: 1,
      byweekday: ["WE"],
      endsMode: "never",
    });
  });
});

describe("rulesEqual", () => {
  it("compares by value, weekday order included", () => {
    expect(
      rulesEqual(
        rule({ freq: "weekly", byweekday: ["MO", "WE"] }),
        rule({ freq: "weekly", byweekday: ["MO", "WE"] }),
      ),
    ).toBe(true);

    expect(
      rulesEqual(
        rule({ freq: "weekly", byweekday: ["MO", "WE"] }),
        rule({ freq: "weekly", byweekday: ["WE", "MO"] }),
      ),
    ).toBe(false);
  });

  it("notices a difference in any field", () => {
    expect(rulesEqual(rule(), rule({ interval: 2 }))).toBe(false);
    expect(rulesEqual(rule(), rule({ endsMode: "after", endsCount: 3 }))).toBe(
      false,
    );
  });
});
