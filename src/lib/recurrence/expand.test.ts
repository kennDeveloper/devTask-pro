import { describe, expect, it } from "vitest";

import { weekdayCode } from "./calendar";
import {
  expand,
  MAX_OCCURRENCES_PER_EXPANSION,
  type ExpansionWindow,
} from "./expand";
import { normaliseRule, type RecurrenceRule } from "./rule";

/**
 * The expander, which is where acceptance criteria 13 and 16 actually live.
 *
 * Every test here is a pure function call with literal dates in and literal
 * dates out. There is no clock to freeze, no timezone to set and no database to
 * seed — which is the entire reason `expand()` takes its window as an argument
 * rather than working one out. A DST-sensitive assertion would be a sign the
 * module had grown a dependency it must not have; the deadline *instant* is
 * `instantFromWallClock`'s job and is tested in `src/lib/time/`.
 */

/** A rule with everything defaulted, so each test states only what it is about. */
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

const YEAR_2026: ExpansionWindow = { from: "2026-01-01", to: "2026-12-31" };

describe("criterion 13 — FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE across 12 weeks", () => {
  const everyOtherMonWed = rule({
    freq: "weekly",
    interval: 2,
    byweekday: ["MO", "WE"],
  });

  it("produces exactly the expected dates from a Monday start", () => {
    // 2026-01-05 is a Monday; the window is the twelve weeks that follow it, so
    // the last eligible week (week 10, starting 16 March) is inside and week 12
    // (30 March) is not.
    expect(
      expand(everyOtherMonWed, "2026-01-05", {
        from: "2026-01-05",
        to: "2026-03-29",
      }),
    ).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-19",
      "2026-01-21",
      "2026-02-02",
      "2026-02-04",
      "2026-02-16",
      "2026-02-18",
      "2026-03-02",
      "2026-03-04",
      "2026-03-16",
      "2026-03-18",
    ]);
  });

  it("anchors on the week containing the start, not on the start itself", () => {
    // Starting on Wednesday the 7th, the first week yields only the Wednesday —
    // its Monday is before DTSTART and so is not in the recurrence set at all.
    // Every week after that yields both. Getting this wrong shifts the whole
    // series by a week.
    expect(
      expand(everyOtherMonWed, "2026-01-07", {
        from: "2026-01-01",
        to: "2026-02-08",
      }),
    ).toEqual(["2026-01-07", "2026-01-19", "2026-01-21", "2026-02-02", "2026-02-04"]);
  });

  it("names only Mondays and Wednesdays, whatever the window", () => {
    for (const date of expand(everyOtherMonWed, "2026-01-05", YEAR_2026)) {
      expect(["MO", "WE"]).toContain(weekdayCode(date));
    }
  });

  it("skips the intervening weeks — exactly 14 days between same-weekday dates", () => {
    const mondays = expand(everyOtherMonWed, "2026-01-05", YEAR_2026).filter(
      (date) => weekdayCode(date) === "MO",
    );
    expect(mondays.length).toBeGreaterThan(4);
    for (let i = 1; i < mondays.length; i += 1) {
      expect(
        (Date.parse(mondays[i]) - Date.parse(mondays[i - 1])) / 86_400_000,
      ).toBe(14);
    }
  });

  it("falls back to the start date's weekday when BYDAY is empty", () => {
    // RFC 5545: an absent BYDAY means "the weekday DTSTART falls on". The editor
    // never produces one; a hand-written rule can.
    expect(
      expand(rule({ freq: "weekly", byweekday: [] }), "2026-01-07", {
        from: "2026-01-01",
        to: "2026-02-01",
      }),
    ).toEqual(["2026-01-07", "2026-01-14", "2026-01-21", "2026-01-28"]);
  });
});

describe("criterion 16 — the five end conditions", () => {
  it("never: keeps producing to the end of the window", () => {
    const dates = expand(rule({ freq: "daily" }), "2026-01-01", {
      from: "2026-01-01",
      to: "2026-01-10",
    });
    expect(dates).toHaveLength(10);
    expect(dates.at(-1)).toBe("2026-01-10");
  });

  it("on <date>: stops there, inclusive", () => {
    expect(
      expand(
        rule({ freq: "daily", endsMode: "on", endsOn: "2026-01-05" }),
        "2026-01-01",
        { from: "2026-01-01", to: "2026-12-31" },
      ),
    ).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
  });

  it("on <date> before the window: produces nothing", () => {
    expect(
      expand(
        rule({ freq: "daily", endsMode: "on", endsOn: "2026-01-05" }),
        "2026-01-01",
        { from: "2026-02-01", to: "2026-12-31" },
      ),
    ).toEqual([]);
  });

  it("after <N>: stops after N", () => {
    expect(
      expand(
        rule({ freq: "weekly", byweekday: ["MO"], endsMode: "after", endsCount: 3 }),
        "2026-01-05",
        YEAR_2026,
      ),
    ).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
  });

  /**
   * The one that is easy to get wrong and impossible to notice.
   *
   * `COUNT` is counted from `starts_on`, so occurrence #7 is the seventh
   * occurrence whatever range you ask about. An implementation that counts what
   * it *emits* gives a different answer per page — /today would show a date that
   * /tasks says the series already ended before.
   */
  it("after <N> is counted from the start, not from the window", () => {
    const counted = rule({ freq: "daily", endsMode: "after", endsCount: 10 });

    expect(expand(counted, "2026-01-01", YEAR_2026)).toHaveLength(10);

    // A window opening mid-series sees only the tail of the same ten.
    expect(
      expand(counted, "2026-01-01", { from: "2026-01-05", to: "2026-12-31" }),
    ).toEqual([
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
      "2026-01-10",
    ]);

    // And a window opening after the tenth sees nothing — not an eleventh.
    expect(
      expand(counted, "2026-01-01", { from: "2026-01-11", to: "2026-12-31" }),
    ).toEqual([]);
  });

  it("a skipped month does not consume one of COUNT's slots", () => {
    // BYMONTHDAY=31 names no day in February, April, June, September or
    // November. Those months are not occurrences, so COUNT=3 spans January,
    // March and May rather than January, February and March.
    expect(
      expand(
        rule({
          freq: "monthly",
          monthMode: "by_date",
          monthDay: 31,
          endsMode: "after",
          endsCount: 3,
        }),
        "2026-01-31",
        YEAR_2026,
      ),
    ).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });
});

describe("criterion 16 — both monthly modes", () => {
  it("by_date picks the same day of each month", () => {
    expect(
      expand(
        rule({ freq: "monthly", monthMode: "by_date", monthDay: 15 }),
        "2026-01-15",
        { from: "2026-01-01", to: "2026-06-30" },
      ),
    ).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-04-15",
      "2026-05-15",
      "2026-06-15",
    ]);
  });

  it("by_date SKIPS a month too short for it — never clamps", () => {
    // Clamping BYMONTHDAY=31 to "the 28th" in February would invent an
    // occurrence the user never asked for, on a date they would then be nagged
    // about. RFC 5545 drops it, and so do we.
    expect(
      expand(
        rule({ freq: "monthly", monthMode: "by_date", monthDay: 31 }),
        "2026-01-31",
        YEAR_2026,
      ),
    ).toEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
    ]);
  });

  it("by_nth_weekday picks the second Tuesday", () => {
    expect(
      expand(
        rule({
          freq: "monthly",
          monthMode: "by_nth_weekday",
          nthWeek: 2,
          nthWeekday: "TU",
        }),
        "2026-01-01",
        { from: "2026-01-01", to: "2026-04-30" },
      ),
    ).toEqual(["2026-01-13", "2026-02-10", "2026-03-10", "2026-04-14"]);
  });

  /** Named explicitly in the criterion, because -1 is the case with its own maths. */
  it("by_nth_weekday picks the LAST FRIDAY of each month", () => {
    expect(
      expand(
        rule({
          freq: "monthly",
          monthMode: "by_nth_weekday",
          nthWeek: -1,
          nthWeekday: "FR",
        }),
        "2026-01-01",
        { from: "2026-01-01", to: "2026-06-30" },
      ),
    ).toEqual([
      "2026-01-30",
      "2026-02-27",
      "2026-03-27",
      "2026-04-24",
      "2026-05-29",
      "2026-06-26",
    ]);
  });

  it("every last Friday really is the last one in its month", () => {
    // The literal list above would still pass if the maths were off by a
    // consistent week, so this asserts the property rather than the values.
    for (const date of expand(
      rule({
        freq: "monthly",
        monthMode: "by_nth_weekday",
        nthWeek: -1,
        nthWeekday: "FR",
      }),
      "2026-01-01",
      YEAR_2026,
    )) {
      expect(weekdayCode(date)).toBe("FR");
      const aWeekLater = new Date(`${date}T00:00:00Z`);
      aWeekLater.setUTCDate(aWeekLater.getUTCDate() + 7);
      expect(aWeekLater.getUTCMonth()).not.toBe(
        new Date(`${date}T00:00:00Z`).getUTCMonth(),
      );
    }
  });

  it("honours the interval — every third month", () => {
    expect(
      expand(
        rule({
          freq: "monthly",
          interval: 3,
          monthMode: "by_date",
          monthDay: 1,
        }),
        "2026-01-01",
        YEAR_2026,
      ),
    ).toEqual(["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);
  });
});

describe("daily and yearly", () => {
  it("daily honours the interval", () => {
    expect(
      expand(rule({ freq: "daily", interval: 3 }), "2026-01-01", {
        from: "2026-01-01",
        to: "2026-01-10",
      }),
    ).toEqual(["2026-01-01", "2026-01-04", "2026-01-07", "2026-01-10"]);
  });

  it("yearly repeats the start's month and day", () => {
    expect(
      expand(rule({ freq: "yearly" }), "2026-08-06", {
        from: "2026-01-01",
        to: "2029-12-31",
      }),
    ).toEqual(["2026-08-06", "2027-08-06", "2028-08-06", "2029-08-06"]);
  });

  it("yearly from 29 February skips every common year", () => {
    // Same rule as BYMONTHDAY=31: the date does not exist, so it is not an
    // occurrence. Moving it to the 28th or 1 March would be inventing one.
    expect(
      expand(rule({ freq: "yearly" }), "2024-02-29", {
        from: "2024-01-01",
        to: "2036-12-31",
      }),
    ).toEqual(["2024-02-29", "2028-02-29", "2032-02-29", "2036-02-29"]);
  });
});

describe("the window", () => {
  it("is inclusive at both ends", () => {
    expect(
      expand(rule({ freq: "daily" }), "2026-01-01", {
        from: "2026-01-03",
        to: "2026-01-05",
      }),
    ).toEqual(["2026-01-03", "2026-01-04", "2026-01-05"]);
  });

  it("never returns a date before the series starts", () => {
    expect(
      expand(rule({ freq: "daily" }), "2026-06-01", {
        from: "2026-01-01",
        to: "2026-06-03",
      }),
    ).toEqual(["2026-06-01", "2026-06-02", "2026-06-03"]);
  });

  it("returns nothing when the window closes before the series starts", () => {
    expect(
      expand(rule({ freq: "daily" }), "2026-06-01", YEAR_2026 && {
        from: "2026-01-01",
        to: "2026-05-31",
      }),
    ).toEqual([]);
  });

  it("returns ascending, distinct dates", () => {
    const dates = expand(
      rule({ freq: "weekly", byweekday: ["MO", "WE", "FR"] }),
      "2026-01-05",
      YEAR_2026,
    );
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("termination", () => {
  /**
   * `ends_mode: "never"` is genuinely infinite, so the bound is a property of
   * the function rather than a policy each caller has to remember.
   */
  it("caps an unbounded daily rule at MAX_OCCURRENCES_PER_EXPANSION", () => {
    const dates = expand(rule({ freq: "daily" }), "2026-01-01", {
      from: "2026-01-01",
      to: "2036-01-01",
    });
    expect(dates).toHaveLength(MAX_OCCURRENCES_PER_EXPANSION);
  });

  it("honours a lower explicit limit", () => {
    expect(
      expand(rule({ freq: "daily" }), "2026-01-01", YEAR_2026, 5),
    ).toHaveLength(5);
  });

  /**
   * The fast-forward. A series started long ago must still list today: walking
   * from `starts_on` one day at a time would run out of periods and silently
   * return nothing, which is the quiet wrongness a cap is supposed to prevent
   * rather than cause.
   */
  it("lists a daily series started in 1900 without walking every day", () => {
    const started = performance.now();
    const dates = expand(rule({ freq: "daily" }), "1900-01-01", {
      from: "2026-01-01",
      to: "2026-01-05",
    });
    expect(dates).toEqual([
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
      "2026-01-05",
    ]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("fast-forwards a weekly series without losing the interval's phase", () => {
    // Fast-forwarding must land on an eligible week, not merely a nearby one.
    // From 2026-01-05, every other Monday is 5, 19, 2 Feb, 16 Feb, 2 Mar…
    expect(
      expand(
        rule({ freq: "weekly", interval: 2, byweekday: ["MO"] }),
        "2026-01-05",
        { from: "2026-02-10", to: "2026-03-31" },
      ),
    ).toEqual(["2026-02-16", "2026-03-02", "2026-03-16", "2026-03-30"]);
  });

  it("fast-forwards a monthly series without losing the interval's phase", () => {
    expect(
      expand(
        rule({
          freq: "monthly",
          interval: 3,
          monthMode: "by_date",
          monthDay: 10,
        }),
        "2020-01-10",
        { from: "2026-01-01", to: "2026-12-31" },
      ),
    ).toEqual(["2026-01-10", "2026-04-10", "2026-07-10", "2026-10-10"]);
  });

  it("fast-forwards a yearly series", () => {
    expect(
      expand(rule({ freq: "yearly", interval: 2 }), "2000-03-15", {
        from: "2026-01-01",
        to: "2030-12-31",
      }),
    ).toEqual(["2026-03-15", "2028-03-15", "2030-03-15"]);
  });
});

describe("malformed input costs the series its rows, not the page", () => {
  it.each([
    ["an unparseable start", "not-a-date", YEAR_2026],
    ["an unparseable window start", "2026-01-01", { from: "x", to: "2026-12-31" }],
    ["an unparseable window end", "2026-01-01", { from: "2026-01-01", to: "x" }],
  ])("returns [] for %s", (_label, startsOn, window) => {
    expect(expand(rule(), startsOn, window as ExpansionWindow)).toEqual([]);
  });

  it("returns [] for a monthly rule with no usable mode", () => {
    // 0005 refuses such a row, so this is only reachable through a hand-built
    // value — but silently producing "the 1st of every month" would be worse.
    expect(
      expand(
        {
          freq: "monthly",
          interval: 1,
          byweekday: [],
          monthMode: null,
          monthDay: null,
          nthWeek: null,
          nthWeekday: null,
          endsMode: "never",
          endsOn: null,
          endsCount: null,
        },
        "2026-01-01",
        YEAR_2026,
      ),
    ).toEqual([]);
  });
});
