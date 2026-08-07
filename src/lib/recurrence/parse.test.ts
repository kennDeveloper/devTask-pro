import { describe, expect, it } from "vitest";

import { NTH_WEEKS, WEEKDAYS, type NthWeek, type Weekday } from "@/lib/db/schema";

import { parse } from "./parse";
import { normaliseRule, rulesEqual, type RecurrenceRule } from "./rule";
import { serialize } from "./serialize";

/**
 * `parse` and the round-trip property that is **acceptance criterion 6**.
 *
 * The property is asserted over the full option matrix rather than over a
 * handful of examples, because the failure mode this guards against is not "the
 * weekly case is broken" — it is "one corner of one case drops a field", which a
 * sample misses by construction. Generating every rule the editor can produce
 * is a few hundred cases and costs milliseconds.
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

/** Every non-empty subset of the seven weekdays, plus the empty one. */
function weekdaySubsets(): Weekday[][] {
  const subsets: Weekday[][] = [];
  for (let mask = 0; mask < 128; mask += 1) {
    subsets.push(WEEKDAYS.filter((_, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

/** The three end conditions, as the partial each contributes to a rule. */
const ENDINGS: Partial<RecurrenceRule>[] = [
  { endsMode: "never" },
  { endsMode: "on", endsOn: "2026-12-31" },
  { endsMode: "on", endsOn: "2027-02-28" },
  { endsMode: "after", endsCount: 1 },
  { endsMode: "after", endsCount: 10 },
  { endsMode: "after", endsCount: 365 },
];

/**
 * Every rule the editor can express.
 *
 * Deliberately a cartesian product: `INTERVAL=1` is omitted from the string
 * while 2 and 3 are not, and `UNTIL` and `COUNT` take different code paths, so
 * the interesting bugs live where those choices cross a frequency.
 */
function everyRule(): RecurrenceRule[] {
  const intervals = [1, 2, 3, 365];
  const rules: RecurrenceRule[] = [];

  for (const ends of ENDINGS) {
    for (const interval of intervals) {
      rules.push(rule({ freq: "daily", interval, ...ends }));
      rules.push(rule({ freq: "yearly", interval, ...ends }));

      for (const byweekday of weekdaySubsets()) {
        rules.push(rule({ freq: "weekly", interval, byweekday, ...ends }));
      }

      for (let monthDay = 1; monthDay <= 31; monthDay += 1) {
        rules.push(
          rule({
            freq: "monthly",
            interval,
            monthMode: "by_date",
            monthDay,
            ...ends,
          }),
        );
      }

      for (const nthWeek of NTH_WEEKS) {
        for (const nthWeekday of WEEKDAYS) {
          rules.push(
            rule({
              freq: "monthly",
              interval,
              monthMode: "by_nth_weekday",
              nthWeek: nthWeek as NthWeek,
              nthWeekday,
              ...ends,
            }),
          );
        }
      }
    }
  }

  return rules;
}

describe("criterion 6 — serialize/parse round-trips the full option matrix", () => {
  const matrix = everyRule();

  it("covers a matrix worth calling one", () => {
    // Guards the guard: a generator that silently produced four rules would make
    // every assertion below pass for the wrong reason.
    expect(matrix.length).toBeGreaterThan(1000);
  });

  it("parse(serialize(rule)) equals rule, for every rule", () => {
    const broken = matrix
      .map((original) => ({ original, parsed: parse(serialize(original)) }))
      .filter(({ original, parsed }) => !parsed || !rulesEqual(original, parsed));

    // Reported as a list rather than as a failing loop, so a systematic break
    // shows its shape instead of stopping at the first case.
    expect(
      broken.map(({ original }) => serialize(original)),
    ).toEqual([]);
  });

  it("serialize(parse(text)) equals text, so the string form is canonical too", () => {
    const broken = matrix
      .map(serialize)
      .filter((text) => {
        const parsed = parse(text);
        return !parsed || serialize(parsed) !== text;
      });

    expect(broken).toEqual([]);
  });
});

describe("what the strings actually look like", () => {
  it.each([
    [
      "the criterion's own example",
      rule({ freq: "weekly", interval: 2, byweekday: ["MO", "WE"] }),
      "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    ],
    ["a plain daily rule", rule({ freq: "daily" }), "FREQ=DAILY"],
    [
      "the last Friday of the month",
      rule({
        freq: "monthly",
        monthMode: "by_nth_weekday",
        nthWeek: -1,
        nthWeekday: "FR",
      }),
      "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
    ],
    [
      "the 15th of every other month",
      rule({ freq: "monthly", interval: 2, monthMode: "by_date", monthDay: 15 }),
      "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15",
    ],
    [
      "ten times and stop",
      rule({ freq: "daily", endsMode: "after", endsCount: 10 }),
      "FREQ=DAILY;COUNT=10",
    ],
    [
      "until the end of the year",
      rule({ freq: "daily", endsMode: "on", endsOn: "2026-12-31" }),
      "FREQ=DAILY;UNTIL=20261231",
    ],
  ])("%s serialises to the expected RFC 5545 value", (_label, value, expected) => {
    expect(serialize(value)).toBe(expected);
  });

  it("omits INTERVAL=1, which is the RFC default", () => {
    // Two spellings of "every week" would both parse, and then two equal rules
    // would compare unequal as strings.
    expect(serialize(rule({ freq: "weekly", byweekday: ["MO"] }))).toBe(
      "FREQ=WEEKLY;BYDAY=MO",
    );
  });

  it("emits UNTIL as a bare DATE, matching a DATE-valued DTSTART", () => {
    // `starts_on` is a `date`, and RFC 5545 requires UNTIL to match DTSTART's
    // value type — so the widely copied `20261231T000000Z` form would be wrong
    // for this schema.
    expect(serialize(rule({ endsMode: "on", endsOn: "2026-12-31" }))).toContain(
      "UNTIL=20261231",
    );
  });
});

describe("parse is forgiving about form and strict about meaning", () => {
  it("accepts the parts in any order", () => {
    expect(parse("BYDAY=MO,WE;INTERVAL=2;FREQ=WEEKLY")).toEqual(
      parse("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"),
    );
  });

  it("accepts lower case and a leading RRULE:", () => {
    expect(parse("rrule:freq=weekly;byday=mo,we")).toEqual(
      parse("FREQ=WEEKLY;BYDAY=MO,WE"),
    );
  });

  it("accepts BYDAY=-1FR, which is what the rrule package emits", () => {
    // The other spelling of "the last Friday". Serialising uses BYSETPOS so that
    // BYDAY holds nothing but weekday codes; parsing accepts both so a string
    // from elsewhere still reads.
    expect(parse("FREQ=MONTHLY;BYDAY=-1FR")).toEqual(
      parse("FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1"),
    );
  });

  it("tolerates a DATE-TIME UNTIL by taking its date half", () => {
    expect(parse("FREQ=DAILY;UNTIL=20261231T000000Z")).toEqual(
      parse("FREQ=DAILY;UNTIL=20261231"),
    );
  });

  it.each([
    ["an empty string", ""],
    ["no FREQ at all", "INTERVAL=2;BYDAY=MO"],
    ["a frequency this app does not support", "FREQ=HOURLY"],
    ["a non-numeric interval", "FREQ=DAILY;INTERVAL=often"],
    ["a zero interval", "FREQ=DAILY;INTERVAL=0"],
    ["a weekday that does not exist", "FREQ=WEEKLY;BYDAY=MO,XX"],
    ["a month day of 45", "FREQ=MONTHLY;BYMONTHDAY=45"],
    ["a month day of 0", "FREQ=MONTHLY;BYMONTHDAY=0"],
    ["both UNTIL and COUNT", "FREQ=DAILY;UNTIL=20261231;COUNT=5"],
    ["a COUNT of 0", "FREQ=DAILY;COUNT=0"],
    ["an unreadable UNTIL", "FREQ=DAILY;UNTIL=tomorrow"],
    ["an impossible UNTIL date", "FREQ=DAILY;UNTIL=20260230"],
    ["a BYSETPOS this app has no column for", "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-2"],
    ["monthly with neither a day nor a weekday", "FREQ=MONTHLY"],
    ["two different offsets in one BYDAY", "FREQ=MONTHLY;BYDAY=1MO,-1FR"],
  ])("returns null for %s rather than guessing", (_label, text) => {
    expect(parse(text)).toBeNull();
  });

  it("normalises what it returns, so a parsed rule can never break 0005's CHECKs", () => {
    // BYDAY on a daily rule is meaningless and `task_series_weekly_days_check`
    // refuses to store it. Dropped rather than carried through.
    const parsed = parse("FREQ=DAILY;BYDAY=MO,WE");
    expect(parsed?.byweekday).toEqual([]);
    expect(parsed?.monthMode).toBeNull();
  });

  it("sorts weekdays into week order, so two spellings compare equal", () => {
    expect(parse("FREQ=WEEKLY;BYDAY=WE,MO")?.byweekday).toEqual(["MO", "WE"]);
  });
});
