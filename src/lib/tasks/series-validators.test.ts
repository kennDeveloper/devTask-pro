import { describe, expect, it } from "vitest";

import {
  SERIES_MESSAGES,
  seriesDeadlineTimeField,
  seriesInput,
  seriesUpdateInput,
  toRecurrenceRule,
} from "./series-validators";

/**
 * The boundary. Every rule asserted here mirrors a constraint in
 * `0005_task_series.sql` — the point of the schema is that a user gets a
 * sentence naming the control they have to change, instead of
 * `task_series_month_day_required_check`.
 */

const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Team standup",
    startsOn: "2026-01-05",
    rule: { freq: "weekly", byweekday: ["MO"] },
    ...overrides,
  };
}

/** The first message attached to a given path, or undefined. */
function issueAt(
  result: ReturnType<typeof seriesInput.safeParse>,
  path: string,
): string | undefined {
  return result.error?.issues.find((issue) => issue.path.join(".") === path)
    ?.message;
}

describe("a valid series", () => {
  it("accepts the simplest weekly rule", () => {
    const result = seriesInput.safeParse(payload());
    expect(result.success).toBe(true);
    expect(result.data?.rule).toMatchObject({
      freq: "weekly",
      interval: 1,
      byweekday: ["MO"],
      endsMode: "never",
    });
  });

  it("defaults the interval and the end mode from the column defaults in 0005", () => {
    const result = seriesInput.safeParse(payload());
    expect(result.data?.rule.interval).toBe(1);
    expect(result.data?.rule.endsMode).toBe("never");
  });

  it("accepts the last Friday of every month", () => {
    expect(
      seriesInput.safeParse(
        payload({
          rule: {
            freq: "monthly",
            monthMode: "by_nth_weekday",
            nthWeek: -1,
            nthWeekday: "FR",
          },
        }),
      ).success,
    ).toBe(true);
  });
});

describe("the cross-field rules — 0005's CHECKs, said in English", () => {
  it("refuses a weekly rule with no days, naming the control", () => {
    const result = seriesInput.safeParse(
      payload({ rule: { freq: "weekly", byweekday: [] } }),
    );
    expect(result.success).toBe(false);
    expect(issueAt(result, "rule.byweekday")).toBe(
      SERIES_MESSAGES.weekdaysRequired,
    );
  });

  it("refuses a monthly rule with no mode", () => {
    const result = seriesInput.safeParse(payload({ rule: { freq: "monthly" } }));
    expect(issueAt(result, "rule.monthMode")).toBe(
      SERIES_MESSAGES.monthModeRequired,
    );
  });

  it("refuses by_date with no day of the month", () => {
    const result = seriesInput.safeParse(
      payload({ rule: { freq: "monthly", monthMode: "by_date" } }),
    );
    expect(issueAt(result, "rule.monthDay")).toBe(
      SERIES_MESSAGES.monthDayRequired,
    );
  });

  it("refuses by_nth_weekday missing either half", () => {
    expect(
      issueAt(
        seriesInput.safeParse(
          payload({
            rule: { freq: "monthly", monthMode: "by_nth_weekday", nthWeekday: "FR" },
          }),
        ),
        "rule.nthWeek",
      ),
    ).toBe(SERIES_MESSAGES.nthWeekRequired);

    expect(
      issueAt(
        seriesInput.safeParse(
          payload({
            rule: { freq: "monthly", monthMode: "by_nth_weekday", nthWeek: 2 },
          }),
        ),
        "rule.nthWeekday",
      ),
    ).toBe(SERIES_MESSAGES.nthWeekdayRequired);
  });

  it("refuses ends_mode 'on' with no date, and 'after' with no count", () => {
    expect(
      issueAt(
        seriesInput.safeParse(
          payload({ rule: { freq: "daily", endsMode: "on" } }),
        ),
        "rule.endsOn",
      ),
    ).toBe(SERIES_MESSAGES.endsOnRequired);

    expect(
      issueAt(
        seriesInput.safeParse(
          payload({ rule: { freq: "daily", endsMode: "after" } }),
        ),
        "rule.endsCount",
      ),
    ).toBe(SERIES_MESSAGES.endsCountRequired);
  });

  it("refuses an end date before the start date", () => {
    // The one rule that crosses the rule and the series it belongs to.
    const result = seriesInput.safeParse(
      payload({
        startsOn: "2026-06-01",
        rule: { freq: "daily", endsMode: "on", endsOn: "2026-01-01" },
      }),
    );
    expect(issueAt(result, "rule.endsOn")).toBe(
      SERIES_MESSAGES.endsOnBeforeStart,
    );
  });

  it("allows an end date equal to the start date", () => {
    expect(
      seriesInput.safeParse(
        payload({
          startsOn: "2026-06-01",
          rule: { freq: "daily", endsMode: "on", endsOn: "2026-06-01" },
        }),
      ).success,
    ).toBe(true);
  });
});

describe("ranges mirror the column CHECKs", () => {
  it.each([
    ["interval 0", { freq: "daily", interval: 0 }],
    ["interval 366", { freq: "daily", interval: 366 }],
    ["a fractional interval", { freq: "daily", interval: 1.5 }],
    ["month day 0", { freq: "monthly", monthMode: "by_date", monthDay: 0 }],
    ["month day 32", { freq: "monthly", monthMode: "by_date", monthDay: 32 }],
    ["nth week 5", { freq: "monthly", monthMode: "by_nth_weekday", nthWeek: 5, nthWeekday: "FR" }],
    ["a count of 0", { freq: "daily", endsMode: "after", endsCount: 0 }],
    ["a count of 366", { freq: "daily", endsMode: "after", endsCount: 366 }],
    ["a frequency that does not exist", { freq: "hourly" }],
    ["a weekday that does not exist", { freq: "weekly", byweekday: ["XX"] }],
  ])("rejects %s", (_label, rule) => {
    expect(seriesInput.safeParse(payload({ rule })).success).toBe(false);
  });

  it.each([
    ["an impossible start date", "2026-02-31"],
    ["an unpadded start date", "2026-2-6"],
    ["a datetime", "2026-02-06T00:00:00Z"],
  ])("rejects %s", (_label, startsOn) => {
    expect(seriesInput.safeParse(payload({ startsOn })).success).toBe(false);
  });
});

describe("seriesDeadlineTimeField", () => {
  it("accepts HH:MM", () => {
    expect(seriesDeadlineTimeField.parse("09:00")).toBe("09:00");
  });

  it("accepts and trims the HH:MM:SS Postgres reads a `time` column back as", () => {
    // So a value that has been to the database and returned still validates
    // without every caller remembering to slice it.
    expect(seriesDeadlineTimeField.parse("09:00:00")).toBe("09:00");
  });

  it("treats an emptied control as 'no deadline', not as an empty string", () => {
    // Two spellings of "no deadline" in one column is something every later
    // `is null` check would have to know about.
    expect(seriesDeadlineTimeField.parse("")).toBeNull();
    expect(seriesDeadlineTimeField.parse(null)).toBeNull();
  });

  it("keeps undefined distinct from null", () => {
    expect(seriesDeadlineTimeField.parse(undefined)).toBeUndefined();
  });

  it.each(["9:00", "24:00:00:00", "nine", "09-00"])(
    "rejects %s",
    (value) => {
      expect(seriesDeadlineTimeField.safeParse(value).success).toBe(false);
    },
  );
});

describe("seriesUpdateInput", () => {
  it("requires an id and the whole rule — it is a replacement, not a patch", () => {
    expect(seriesUpdateInput.safeParse(payload()).success).toBe(false);
    expect(
      seriesUpdateInput.safeParse({ ...payload(), id: SERIES_ID }).success,
    ).toBe(true);
  });

  it("rejects a malformed id at the boundary rather than as a cast error", () => {
    expect(
      seriesUpdateInput.safeParse({ ...payload(), id: "not-a-uuid" }).success,
    ).toBe(false);
  });

  it("applies the same cross-field rules as create", () => {
    const result = seriesUpdateInput.safeParse({
      ...payload({ rule: { freq: "monthly" } }),
      id: SERIES_ID,
    });
    expect(result.success).toBe(false);
  });
});

describe("toRecurrenceRule", () => {
  it("clears the fields the chosen frequency does not use", () => {
    // Zod proves each field is in range; `normaliseRule` decides which of them
    // this frequency actually uses. Without it the row breaks
    // `task_series_weekly_days_check`.
    const parsed = seriesInput.parse(
      payload({
        rule: {
          freq: "monthly",
          byweekday: ["MO", "WE"],
          monthMode: "by_date",
          monthDay: 15,
          nthWeek: 2,
          nthWeekday: "TU",
        },
      }),
    );

    const rule = toRecurrenceRule(parsed.rule);
    expect(rule.byweekday).toEqual([]);
    expect(rule.nthWeek).toBeNull();
    expect(rule.nthWeekday).toBeNull();
    expect(rule.monthDay).toBe(15);
  });
});
