import { describe, expect, it } from "vitest";

import { UTC } from "@/lib/profile-form";
import {
  isIsoDate,
  resolveTimeZone,
  todayInZone,
  toIsoDate,
  wallClockInZone,
  zoneOffsetMs,
} from "@/lib/time/user-tz";

describe("todayInZone", () => {
  /**
   * Criteria 18 and 19 in one assertion. The instant is 15:00 UTC on the 15th,
   * by which point Manila (+08:00) is at 23:00 on the *same* date — but two
   * hours later the server has rolled over and Manila has not. A "today" taken
   * from the server clock shows the wrong day for eight hours out of every
   * twenty-four for this user.
   */
  it("gives the user's date, not the server's, across the rollover", () => {
    const beforeServerMidnight = new Date("2024-01-15T15:00:00.000Z");
    expect(todayInZone("Asia/Manila", beforeServerMidnight)).toBe("2024-01-15");
    expect(todayInZone(UTC, beforeServerMidnight)).toBe("2024-01-15");

    // 22:00 in Manila, and the UTC server is already on the 16th.
    const afterServerMidnight = new Date("2024-01-15T14:00:00.000Z");
    expect(todayInZone("Asia/Manila", afterServerMidnight)).toBe("2024-01-15");

    const serverOnNextDay = new Date("2024-01-16T00:30:00.000Z");
    expect(todayInZone(UTC, serverOnNextDay)).toBe("2024-01-16");
    expect(todayInZone("Asia/Manila", serverOnNextDay)).toBe("2024-01-16");

    // The window where they genuinely disagree: 16:30 UTC on the 15th is
    // already 00:30 on the 16th in Manila.
    const manilaAheadOfServer = new Date("2024-01-15T16:30:00.000Z");
    expect(todayInZone(UTC, manilaAheadOfServer)).toBe("2024-01-15");
    expect(todayInZone("Asia/Manila", manilaAheadOfServer)).toBe("2024-01-16");
  });

  it("lands on the correct side of local midnight, in both directions", () => {
    // Manila midnight opening the 16th is 2024-01-15T16:00:00Z.
    expect(
      todayInZone("Asia/Manila", new Date("2024-01-15T15:59:59.999Z")),
    ).toBe("2024-01-15");
    expect(
      todayInZone("Asia/Manila", new Date("2024-01-15T16:00:00.000Z")),
    ).toBe("2024-01-16");
    expect(
      todayInZone("Asia/Manila", new Date("2024-01-15T16:00:00.001Z")),
    ).toBe("2024-01-16");
  });

  /**
   * The guard against hour-based arithmetic. Any implementation that rounds a
   * zone to whole hours puts Kolkata's boundary half an hour out, and the two
   * assertions here straddle exactly that half hour.
   */
  it("is correct for a half-hour offset zone (Asia/Kolkata, +05:30)", () => {
    // Kolkata midnight opening the 16th is 2024-01-15T18:30:00Z.
    expect(
      todayInZone("Asia/Kolkata", new Date("2024-01-15T18:29:59.999Z")),
    ).toBe("2024-01-15");
    expect(
      todayInZone("Asia/Kolkata", new Date("2024-01-15T18:30:00.000Z")),
    ).toBe("2024-01-16");

    // ...and where a whole-hour approximation would have put it.
    expect(
      todayInZone("Asia/Kolkata", new Date("2024-01-15T19:00:00.000Z")),
    ).toBe("2024-01-16");
  });

  it("is correct for a quarter-hour offset zone (Asia/Kathmandu, +05:45)", () => {
    expect(
      todayInZone("Asia/Kathmandu", new Date("2024-01-15T18:14:59.999Z")),
    ).toBe("2024-01-15");
    expect(
      todayInZone("Asia/Kathmandu", new Date("2024-01-15T18:15:00.000Z")),
    ).toBe("2024-01-16");
  });

  it("is correct for a negative offset zone (America/Los_Angeles)", () => {
    // 08:00 UTC on the 15th is still 00:00 on the 15th in LA (PST, −08:00).
    expect(
      todayInZone("America/Los_Angeles", new Date("2024-01-15T07:59:59.999Z")),
    ).toBe("2024-01-14");
    expect(
      todayInZone("America/Los_Angeles", new Date("2024-01-15T08:00:00.000Z")),
    ).toBe("2024-01-15");

    // The whole UTC morning of the 15th is still the 14th in LA — the mirror
    // image of the Manila case, and the one a UTC server gets wrong in the
    // other direction.
    expect(
      todayInZone("America/Los_Angeles", new Date("2024-01-15T03:00:00.000Z")),
    ).toBe("2024-01-14");
  });

  it("handles the far edges of the offset range", () => {
    const instant = new Date("2024-01-15T12:00:00.000Z");
    // Kiritimati is +14:00 — a full calendar day ahead of the server.
    expect(todayInZone("Pacific/Kiritimati", instant)).toBe("2024-01-16");
    // Niue is −11:00.
    expect(todayInZone("Pacific/Niue", instant)).toBe("2024-01-15");
    expect(
      todayInZone("Pacific/Niue", new Date("2024-01-15T10:00:00.000Z")),
    ).toBe("2024-01-14");
  });

  it("pads single-digit months and days", () => {
    expect(todayInZone(UTC, new Date("2024-03-05T12:00:00.000Z"))).toBe(
      "2024-03-05",
    );
  });
});

describe("resolveTimeZone", () => {
  /**
   * The database column is free text as far as the runtime is concerned, and
   * `Intl.DateTimeFormat` throws a RangeError on a zone it does not know. A 500
   * on the task list is a worse failure than a few hours' drift.
   */
  it("falls back to UTC rather than throwing on an unknown zone", () => {
    expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(UTC);
    expect(resolveTimeZone("")).toBe(UTC);
    expect(resolveTimeZone(null)).toBe(UTC);
    expect(resolveTimeZone(undefined)).toBe(UTC);
    expect(resolveTimeZone("not a zone at all")).toBe(UTC);
  });

  it("keeps a zone the validator would also accept", () => {
    expect(resolveTimeZone("Asia/Manila")).toBe("Asia/Manila");
    expect(resolveTimeZone(UTC)).toBe(UTC);
  });

  /**
   * THE PORTABILITY TRAP, pinned.
   *
   * `Intl.supportedValuesOf("timeZone")` enumerates whichever spellings the
   * host engine's CLDR data calls primary, and engines disagree: this Node
   * lists `Asia/Calcutta` and not `Asia/Kolkata`, while a browser that has
   * shipped the ECMA-402 canonicalization change reports the opposite. Since
   * `resolveTimeZone` runs on both sides of the wire and criterion 19 requires
   * them to agree, **both** spellings have to resolve to a usable zone and give
   * the same day — which is what the second, tz-database-backed check buys.
   *
   * The assertions are written to hold whichever list this runtime happens to
   * have, so they keep their meaning when Node's ICU is updated.
   */
  it("accepts a zone under either spelling, whichever this engine enumerates", () => {
    const instant = new Date("2024-01-15T18:45:00.000Z");
    for (const [modern, legacy] of [
      ["Asia/Kolkata", "Asia/Calcutta"],
      ["Asia/Kathmandu", "Asia/Katmandu"],
      ["Europe/Kyiv", "Europe/Kiev"],
      ["Asia/Ho_Chi_Minh", "Asia/Saigon"],
    ]) {
      // Neither spelling may silently degrade to UTC...
      expect(resolveTimeZone(modern)).not.toBe(UTC);
      expect(resolveTimeZone(legacy)).not.toBe(UTC);
      // ...and both must name the same place.
      expect(todayInZone(modern, instant)).toBe(todayInZone(legacy, instant));
      expect(zoneOffsetMs(modern, instant)).toBe(zoneOffsetMs(legacy, instant));
    }
  });

  it("makes every reader survive an unknown zone", () => {
    const instant = new Date("2024-01-15T12:00:00.000Z");
    expect(() => todayInZone("Mars/Olympus_Mons", instant)).not.toThrow();
    expect(todayInZone("Mars/Olympus_Mons", instant)).toBe(
      todayInZone(UTC, instant),
    );
    expect(zoneOffsetMs("Mars/Olympus_Mons", instant)).toBe(0);
  });

  it("caches the verdict, so a bad zone costs one throw and not one per call", () => {
    const instant = new Date("2024-01-15T12:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      expect(resolveTimeZone("Mars/Olympus_Mons")).toBe(UTC);
      expect(todayInZone("Mars/Olympus_Mons", instant)).toBe("2024-01-15");
    }
  });
});

describe("wallClockInZone", () => {
  it("reports 1-based months and a 0–23 hour", () => {
    expect(
      wallClockInZone("Asia/Manila", new Date("2024-01-15T14:05:06.000Z")),
    ).toEqual({
      year: 2024,
      month: 1,
      day: 15,
      hour: 22,
      minute: 5,
      second: 6,
    });
  });

  /**
   * The `hour12: false` bug this file pins `hourCycle: "h23"` to avoid: some
   * ICU builds render midnight as hour 24, which reads as "the next day has
   * already started" to anything doing arithmetic on the number.
   */
  it("renders midnight as hour 0, never 24", () => {
    expect(
      wallClockInZone(UTC, new Date("2024-01-15T00:00:00.000Z")).hour,
    ).toBe(0);
    expect(
      wallClockInZone("Asia/Manila", new Date("2024-01-14T16:00:00.000Z")),
    ).toMatchObject({ day: 15, hour: 0 });
  });
});

describe("zoneOffsetMs", () => {
  const HOUR = 3_600_000;

  it("measures fixed offsets, positive and negative", () => {
    const instant = new Date("2024-01-15T12:00:00.000Z");
    expect(zoneOffsetMs(UTC, instant)).toBe(0);
    expect(zoneOffsetMs("Asia/Manila", instant)).toBe(8 * HOUR);
    expect(zoneOffsetMs("Asia/Kolkata", instant)).toBe(5.5 * HOUR);
    expect(zoneOffsetMs("Asia/Kathmandu", instant)).toBe(5.75 * HOUR);
    expect(zoneOffsetMs("America/Los_Angeles", instant)).toBe(-8 * HOUR);
  });

  /** The reason a zone cannot be cached as a number: it is a function of time. */
  it("changes across a DST transition", () => {
    expect(
      zoneOffsetMs("America/Los_Angeles", new Date("2024-01-15T12:00:00Z")),
    ).toBe(-8 * HOUR);
    expect(
      zoneOffsetMs("America/Los_Angeles", new Date("2024-07-15T12:00:00Z")),
    ).toBe(-7 * HOUR);
  });

  /**
   * `Intl` reports whole seconds only. Without truncating the instant first,
   * the leftover milliseconds come back as a fractional offset and land
   * directly in a computed day boundary.
   */
  it("is unaffected by sub-second precision", () => {
    expect(zoneOffsetMs("Asia/Manila", new Date("2024-01-15T12:00:00.789Z"))).toBe(
      8 * HOUR,
    );
  });
});

describe("isIsoDate / toIsoDate", () => {
  it("accepts real dates", () => {
    expect(isIsoDate("2024-01-15")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
  });

  it("rejects malformed strings", () => {
    expect(isIsoDate("2024-1-15")).toBe(false);
    expect(isIsoDate("15/01/2024")).toBe(false);
    expect(isIsoDate("2024-01-15T00:00:00Z")).toBe(false);
    expect(isIsoDate("")).toBe(false);
  });

  /** `Date.UTC` rolls overflow forward silently, so this needs a round-trip check. */
  it("rejects dates that do not exist", () => {
    expect(isIsoDate("2023-02-29")).toBe(false);
    expect(isIsoDate("2024-02-30")).toBe(false);
    expect(isIsoDate("2024-13-01")).toBe(false);
    expect(isIsoDate("2024-00-10")).toBe(false);
  });

  it("pads to a stable width", () => {
    expect(toIsoDate({ year: 2024, month: 3, day: 5 })).toBe("2024-03-05");
  });
});
