import { describe, expect, it } from "vitest";

import { WEEKDAYS } from "@/lib/db/schema";

import {
  addDays,
  addMonths,
  compareIsoDates,
  daysBetween,
  daysInMonth,
  formatIsoDate,
  isValidCalendarDate,
  monthsBetween,
  nthWeekdayOfMonth,
  parseIsoDate,
  startOfIsoWeek,
  weekdayCode,
  weekdayIndex,
  WEEKDAY_OFFSET,
} from "./calendar";

/**
 * Calendar arithmetic, tested where it is easy to be subtly wrong: month
 * lengths, leap years, and the Monday-vs-Sunday week start that shifts every
 * weekly rule by a day if it is got wrong.
 *
 * Nothing here needs a clock or a zone, which is the whole point of the module.
 */

describe("parseIsoDate", () => {
  it("reads a well-formed date", () => {
    expect(parseIsoDate("2026-08-06")).toEqual({
      year: 2026,
      month: 8,
      day: 6,
    });
  });

  it.each([
    ["a date that does not exist", "2026-02-30"],
    ["month 13", "2026-13-01"],
    ["day 0", "2026-01-00"],
    ["an unpadded month", "2026-8-06"],
    ["a datetime", "2026-08-06T00:00:00Z"],
    ["nonsense", "yesterday"],
    ["empty", ""],
  ])("rejects %s", (_label, value) => {
    expect(parseIsoDate(value)).toBeNull();
  });

  it("accepts 29 February in a leap year and rejects it otherwise", () => {
    expect(parseIsoDate("2024-02-29")).not.toBeNull();
    expect(parseIsoDate("2026-02-29")).toBeNull();
  });
});

describe("isValidCalendarDate", () => {
  it("rejects overflow rather than letting Date roll it forward", () => {
    // `Date.UTC(2026, 1, 30)` silently becomes 2 March, which is exactly why the
    // round-trip check exists.
    expect(isValidCalendarDate(2026, 2, 30)).toBe(false);
    expect(isValidCalendarDate(2026, 2, 28)).toBe(true);
  });

  it("rejects non-integers", () => {
    expect(isValidCalendarDate(2026, 1.5, 1)).toBe(false);
  });
});

describe("daysInMonth", () => {
  it.each([
    [2026, 1, 31],
    [2026, 2, 28],
    [2024, 2, 29],
    [2000, 2, 29],
    [1900, 2, 28],
    [2026, 4, 30],
    [2026, 12, 31],
  ])("%i-%i has %i days", (year, month, expected) => {
    expect(daysInMonth(year, month)).toBe(expected);
  });
});

describe("addDays", () => {
  it("crosses a month boundary", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
  });

  it("crosses a year boundary in both directions", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("knows February's length", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("returns malformed input unchanged rather than throwing", () => {
    // This runs inside a list read; a stored rule that has rotted should cost
    // that series its rows, not the page.
    expect(addDays("not-a-date", 1)).toBe("not-a-date");
  });
});

describe("addMonths", () => {
  it("wraps the year forwards and backwards", () => {
    expect(addMonths(2026, 11, 3)).toEqual({ year: 2027, month: 2 });
    expect(addMonths(2026, 2, -3)).toEqual({ year: 2025, month: 11 });
  });

  it("returns a pair, never a date — the day is the caller's problem", () => {
    // "The 31st, one month after January" names no day at all, and answering it
    // with a rolled-forward 3 March is how a rule gains an occurrence nobody
    // asked for.
    expect(addMonths(2026, 1, 1)).toEqual({ year: 2026, month: 2 });
  });
});

describe("weekdayIndex / weekdayCode", () => {
  it("is Monday-based, matching WEEKDAYS and RFC 5545's default WKST", () => {
    // 2026-01-05 is a Monday.
    expect(weekdayIndex("2026-01-05")).toBe(0);
    expect(weekdayCode("2026-01-05")).toBe("MO");
    expect(weekdayCode("2026-01-11")).toBe("SU");
  });

  it("agrees with WEEKDAYS across a whole week", () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const date = addDays("2026-01-05", offset);
      expect(weekdayCode(date)).toBe(WEEKDAYS[offset]);
      expect(WEEKDAY_OFFSET[weekdayCode(date)]).toBe(offset);
    }
  });
});

describe("startOfIsoWeek", () => {
  it("returns the Monday of that week", () => {
    expect(startOfIsoWeek("2026-01-07")).toBe("2026-01-05");
    expect(startOfIsoWeek("2026-01-05")).toBe("2026-01-05");
    // Sunday belongs to the week that began the previous Monday.
    expect(startOfIsoWeek("2026-01-11")).toBe("2026-01-05");
  });
});

describe("nthWeekdayOfMonth", () => {
  it("finds the first and second of a weekday", () => {
    expect(nthWeekdayOfMonth(2026, 1, "MO", 1)).toBe("2026-01-05");
    expect(nthWeekdayOfMonth(2026, 1, "MO", 2)).toBe("2026-01-12");
  });

  it("finds the last, which is the case that is easy to get wrong", () => {
    // January 2026 ends on a Saturday, so the last Friday is the 30th.
    expect(nthWeekdayOfMonth(2026, 1, "FR", -1)).toBe("2026-01-30");
    // February 2026 ends on a Saturday too, but is four days shorter.
    expect(nthWeekdayOfMonth(2026, 2, "FR", -1)).toBe("2026-02-27");
  });

  it("agrees with itself: the last is a real day of that weekday, and a week later is not", () => {
    for (let month = 1; month <= 12; month += 1) {
      const last = nthWeekdayOfMonth(2026, month, "FR", -1)!;
      expect(weekdayCode(last)).toBe("FR");
      // The proof that it really is the last one.
      expect(parseIsoDate(addDays(last, 7))!.month).not.toBe(month);
    }
  });

  it("returns null when the month has no such occurrence", () => {
    // Not reachable from the app — nth is 1..4 or -1 and every month holds at
    // least four of each weekday — but the branch has to be honest.
    expect(nthWeekdayOfMonth(2026, 2, "MO", 5)).toBeNull();
  });
});

describe("daysBetween / monthsBetween", () => {
  it("counts whole days, signed", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
    expect(daysBetween("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("counts across a leap day", () => {
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-02-28", "2026-03-01")).toBe(1);
  });

  it("counts whole months, signed", () => {
    expect(monthsBetween(2026, 1, 2027, 3)).toBe(14);
    expect(monthsBetween(2027, 3, 2026, 1)).toBe(-14);
  });
});

describe("compareIsoDates / formatIsoDate", () => {
  it("orders correctly across a year boundary", () => {
    expect(compareIsoDates("2026-12-31", "2027-01-01")).toBeLessThan(0);
    expect(compareIsoDates("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("zero-pads, which is what makes the string comparison correct", () => {
    expect(formatIsoDate({ year: 2026, month: 1, day: 5 })).toBe("2026-01-05");
    expect(formatIsoDate({ year: 999, month: 12, day: 31 })).toBe("0999-12-31");
  });
});
