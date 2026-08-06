import { describe, expect, it } from "vitest";

import { UTC } from "@/lib/profile-form";
import {
  addDaysToIsoDate,
  dayRangeInZone,
  startOfDayInZone,
} from "@/lib/time/day-boundary";
import { todayInZone } from "@/lib/time/user-tz";

const HOUR = 3_600_000;

/** `[start, end)` as ISO strings — far easier to read in a failure message. */
function isoRange(timeZone: string, isoDate: string) {
  const { start, end } = dayRangeInZone(timeZone, isoDate);
  return [start.toISOString(), end.toISOString()];
}

describe("startOfDayInZone", () => {
  it("finds local midnight for a positive offset (Asia/Manila, +08:00)", () => {
    expect(startOfDayInZone("Asia/Manila", "2024-01-15").toISOString()).toBe(
      "2024-01-14T16:00:00.000Z",
    );
  });

  it("finds local midnight for a negative offset (America/Los_Angeles)", () => {
    expect(
      startOfDayInZone("America/Los_Angeles", "2024-01-15").toISOString(),
    ).toBe("2024-01-15T08:00:00.000Z");
  });

  it("finds local midnight for a half-hour offset (Asia/Kolkata, +05:30)", () => {
    expect(startOfDayInZone("Asia/Kolkata", "2024-01-15").toISOString()).toBe(
      "2024-01-14T18:30:00.000Z",
    );
  });

  it("is the identity in UTC", () => {
    expect(startOfDayInZone(UTC, "2024-01-15").toISOString()).toBe(
      "2024-01-15T00:00:00.000Z",
    );
  });

  it("falls back to UTC for an unknown zone instead of throwing", () => {
    expect(() => startOfDayInZone("Mars/Olympus_Mons", "2024-01-15")).not.toThrow();
    expect(
      startOfDayInZone("Mars/Olympus_Mons", "2024-01-15").toISOString(),
    ).toBe("2024-01-15T00:00:00.000Z");
  });

  it("refuses a malformed or impossible date", () => {
    expect(() => startOfDayInZone(UTC, "2024-1-15")).toThrow(RangeError);
    expect(() => startOfDayInZone(UTC, "2024-02-30")).toThrow(RangeError);
    expect(() => startOfDayInZone(UTC, "tomorrow")).toThrow(RangeError);
  });
});

describe("dayRangeInZone", () => {
  /**
   * The boundary criterion 18 rests on. A task due 23:00 Manila time on the
   * 15th sits inside the 15th's range and outside the 16th's, even though the
   * instant it maps to (15:00 UTC) is on neither boundary from a UTC server's
   * point of view.
   */
  it("brackets a Manila day, so a 23:00 deadline belongs to that day", () => {
    expect(isoRange("Asia/Manila", "2024-01-15")).toEqual([
      "2024-01-14T16:00:00.000Z",
      "2024-01-15T16:00:00.000Z",
    ]);

    const dueAt23Manila = new Date("2024-01-15T15:00:00.000Z");
    const { start, end } = dayRangeInZone("Asia/Manila", "2024-01-15");
    expect(dueAt23Manila.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(dueAt23Manila.getTime()).toBeLessThan(end.getTime());
  });

  it("is half-open — start is in the day, end is not", () => {
    const { start, end } = dayRangeInZone("Asia/Manila", "2024-01-15");
    expect(todayInZone("Asia/Manila", start)).toBe("2024-01-15");
    expect(todayInZone("Asia/Manila", new Date(start.getTime() - 1))).toBe(
      "2024-01-14",
    );
    expect(todayInZone("Asia/Manila", new Date(end.getTime() - 1))).toBe(
      "2024-01-15",
    );
    expect(todayInZone("Asia/Manila", end)).toBe("2024-01-16");
  });

  it("tiles with the neighbouring days — no gap, no overlap", () => {
    for (const zone of [
      UTC,
      "Asia/Manila",
      "Asia/Kolkata",
      "America/Los_Angeles",
      "Pacific/Auckland",
    ]) {
      const first = dayRangeInZone(zone, "2024-01-15");
      const second = dayRangeInZone(zone, "2024-01-16");
      expect(first.end.getTime()).toBe(second.start.getTime());
    }
  });

  /**
   * The round-trip property, sampled at a fine enough grain to catch a boundary
   * that is off by a quarter hour: every instant inside the range maps back to
   * the date that produced it.
   */
  it("round-trips: every instant inside the range reports the same date", () => {
    const zones = [
      UTC,
      "Asia/Manila",
      "Asia/Kolkata",
      "Asia/Kathmandu",
      "America/Los_Angeles",
      "Pacific/Auckland",
      "Pacific/Kiritimati",
      "Australia/Lord_Howe",
    ];

    for (const zone of zones) {
      for (const isoDate of ["2024-01-15", "2024-07-15", "2024-12-31"]) {
        const { start, end } = dayRangeInZone(zone, isoDate);
        for (
          let instant = start.getTime();
          instant < end.getTime();
          instant += 5 * 60_000
        ) {
          expect(todayInZone(zone, new Date(instant))).toBe(isoDate);
        }
        // ...and the instants immediately outside do not.
        expect(todayInZone(zone, new Date(start.getTime() - 1))).not.toBe(
          isoDate,
        );
        expect(todayInZone(zone, end)).not.toBe(isoDate);
      }
    }
  });

  it("round-trips for a date derived from todayInZone, which is how it is used", () => {
    const now = new Date("2024-01-15T14:00:00.000Z"); // 22:00 in Manila
    const today = todayInZone("Asia/Manila", now);
    const { start, end } = dayRangeInZone("Asia/Manila", today);
    expect(now.getTime()).toBeGreaterThanOrEqual(start.getTime());
    expect(now.getTime()).toBeLessThan(end.getTime());
  });
});

/**
 * Day-boundary DST only. Whether a *recurring* task keeps its local time across
 * a transition is criterion 20 and belongs to phase 3 — these assertions stop
 * at "the day is bracketed correctly", which is what the overdue and today
 * queries depend on.
 */
describe("dayRangeInZone across DST transitions", () => {
  it("spans 23 hours on a spring-forward day", () => {
    const { start, end } = dayRangeInZone(
      "America/Los_Angeles",
      "2024-03-10", // 02:00 → 03:00 local
    );
    expect(start.toISOString()).toBe("2024-03-10T08:00:00.000Z");
    expect(end.toISOString()).toBe("2024-03-11T07:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });

  it("spans 25 hours on a fall-back day", () => {
    const { start, end } = dayRangeInZone(
      "America/Los_Angeles",
      "2024-11-03", // 02:00 → 01:00 local
    );
    expect(start.toISOString()).toBe("2024-11-03T07:00:00.000Z");
    expect(end.toISOString()).toBe("2024-11-04T08:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(25 * HOUR);
  });

  /**
   * The case that defeats resolving the offset only once. Auckland's local day
   * of 2024-04-07 opens at +13:00, but by 00:00 UTC on that date the clocks
   * have already gone back to +12:00 — so the offset read against a UTC-midnight
   * guess is not the offset in force at local midnight, and subtracting it
   * lands an hour *inside* the day.
   */
  it("resolves the offset in force at local midnight, not at UTC midnight", () => {
    const { start } = dayRangeInZone("Pacific/Auckland", "2024-04-07");
    expect(start.toISOString()).toBe("2024-04-06T11:00:00.000Z");
    expect(todayInZone("Pacific/Auckland", start)).toBe("2024-04-07");
    expect(
      todayInZone("Pacific/Auckland", new Date(start.getTime() - 1)),
    ).toBe("2024-04-06");
  });

  /**
   * A local midnight that never happened: Havana springs forward *at* 00:00, so
   * 2023-03-12 begins at 01:00 local. The naive "subtract the offset" answer is
   * 23:00 on the 11th, which would file a whole day of tasks under the wrong
   * date.
   */
  it("handles a local midnight that does not exist", () => {
    const { start, end } = dayRangeInZone("America/Havana", "2023-03-12");
    expect(start.toISOString()).toBe("2023-03-12T05:00:00.000Z");
    expect(todayInZone("America/Havana", start)).toBe("2023-03-12");
    expect(todayInZone("America/Havana", new Date(start.getTime() - 1))).toBe(
      "2023-03-11",
    );
    expect(end.getTime() - start.getTime()).toBe(23 * HOUR);
  });

  it("handles a half-hour DST shift (Australia/Lord_Howe, +10:30/+11:00)", () => {
    const { start, end } = dayRangeInZone("Australia/Lord_Howe", "2024-04-07");
    expect(end.getTime() - start.getTime()).toBe(24.5 * HOUR);
    expect(todayInZone("Australia/Lord_Howe", start)).toBe("2024-04-07");
    expect(
      todayInZone("Australia/Lord_Howe", new Date(end.getTime() - 1)),
    ).toBe("2024-04-07");
  });
});

describe("addDaysToIsoDate", () => {
  it("moves forward and backward", () => {
    expect(addDaysToIsoDate("2024-01-15", 1)).toBe("2024-01-16");
    expect(addDaysToIsoDate("2024-01-15", -1)).toBe("2024-01-14");
    expect(addDaysToIsoDate("2024-01-15", 0)).toBe("2024-01-15");
  });

  it("crosses month, year and leap-day boundaries", () => {
    expect(addDaysToIsoDate("2024-01-31", 1)).toBe("2024-02-01");
    expect(addDaysToIsoDate("2024-12-31", 1)).toBe("2025-01-01");
    expect(addDaysToIsoDate("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToIsoDate("2023-02-28", 1)).toBe("2023-03-01");
    expect(addDaysToIsoDate("2024-03-01", -1)).toBe("2024-02-29");
  });

  /**
   * Calendar arithmetic, not clock arithmetic. Adding a day on a 23-hour local
   * day must still land on the next calendar date — which is why this works in
   * UTC and leaves the zone entirely to `startOfDayInZone`.
   */
  it("is unaffected by DST in any zone", () => {
    expect(addDaysToIsoDate("2024-03-10", 1)).toBe("2024-03-11");
    expect(addDaysToIsoDate("2024-11-03", 1)).toBe("2024-11-04");
  });

  it("refuses a malformed date", () => {
    expect(() => addDaysToIsoDate("2024-2-30", 1)).toThrow(RangeError);
  });
});
