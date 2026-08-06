/**
 * Turning a local calendar day back into the pair of UTC instants that bound it.
 *
 * `user-tz.ts` answers "what day is it *there*?". This file answers the inverse,
 * which is the one the database needs: `deadline_at` is `timestamptz`, so
 * "everything due today" has to become `deadline_at >= $start and
 * deadline_at < $end` with two absolute instants. Get those instants from the
 * server's own midnight and criterion 18 fails by however many hours separate
 * the server from the user.
 *
 * ## The trap: local midnight is not "the date at 00:00 UTC minus an offset"
 *
 * A zone's offset is a function of the *instant*, not of the date, and the
 * offset in force at 00:00 UTC on a given date is not always the offset in
 * force at local midnight on that same date. `Pacific/Auckland` on 2024-04-07
 * is the worked example: the local day begins at 00:00 NZDT (+13), but by
 * 00:00 UTC that day the clocks have already gone back to NZST (+12). Subtract
 * "the offset" and you land an hour late, inside the day rather than at its
 * start. So the offset is resolved twice — once against a first guess, once
 * against the instant that guess produced — and both answers are then *checked*
 * rather than trusted.
 *
 * ## Two days a year, local midnight is not a single well-defined instant
 *
 * - **It may not exist.** Where DST springs forward *at* midnight
 *   (`America/Havana`, 2023-03-12) the clocks read 23:59:59 and then 01:00:00;
 *   there is no 00:00. The correct start of that local day is the transition
 *   instant itself — the first moment the date is the new one. Picking the
 *   candidate whose local date actually matches gets this right; naive
 *   subtraction lands at 23:00 on the *previous* day and silently shifts a
 *   whole day of tasks.
 * - **It may happen twice.** Where DST falls back *through* midnight the local
 *   date can go backwards for an hour. This code resolves that to the *later*
 *   occurrence, so the first (repeated) hour is attributed to the previous day.
 *   The only zones that ever did this retired the practice years ago
 *   (`America/Sao_Paulo` before 2019); it is called out because it is the one
 *   case where the round-trip property below does not hold, and a future reader
 *   should know it is a known choice rather than an oversight.
 *
 * A day is therefore **not** 24 hours: `dayRangeInZone` spans 23 hours on a
 * spring-forward day and 25 on a fall-back one, because `end` is computed as
 * the start of the *next* local day rather than `start + 24h`. That is also
 * what keeps consecutive ranges tiling the timeline with no gap and no overlap.
 */

import { addDays, type CalendarDate } from "@/lib/recurrence/calendar";
import { isIsoDate, todayInZone, zoneOffsetMs } from "@/lib/time/user-tz";

/** The UTC instants bounding one local calendar day: `[start, end)`. */
export interface DayRange {
  /** First instant of the local day. **Inclusive.** */
  start: Date;
  /** First instant of the *next* local day. **Exclusive.** */
  end: Date;
}

/**
 * A malformed date is a programming error, not data.
 *
 * The asymmetry with `resolveTimeZone` — which quietly falls back to UTC — is
 * deliberate. A timezone arrives from a database column and can rot on its own;
 * an ISO date arrives from `todayInZone` or from a Zod-validated input one
 * stack frame away, so a bad one means a caller built it wrong. Silently
 * returning a range around `Invalid Date` would surface as an empty task list
 * with no explanation, which is far harder to diagnose than a throw at the
 * point of the mistake.
 */
function requireIsoDate(isoDate: string): [number, number, number] {
  if (!isIsoDate(isoDate)) {
    throw new RangeError(
      `Expected a YYYY-MM-DD calendar date, received ${JSON.stringify(isoDate)}`,
    );
  }
  const [year, month, day] = isoDate.split("-").map(Number);
  return [year, month, day];
}

/**
 * Shift an ISO date by whole days, staying in calendar space.
 *
 * Done in UTC on purpose: this is pure calendar arithmetic with no zone
 * involved, so month lengths and leap years are handled by `Date` while DST —
 * which would make "add 24 hours" wrong twice a year — never enters the
 * picture. `dayRangeInZone` gets its zone-awareness from resolving each day's
 * start independently, not from this function.
 *
 * The arithmetic itself lives in `src/lib/recurrence/calendar.ts`, which is the
 * module that owns calendar-space questions and knows nothing about zones. This
 * wrapper adds the throw-on-malformed contract described above, which the
 * recurrence engine deliberately does not want: an unparseable stored rule
 * should cost that series its rows, not the page.
 */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  requireIsoDate(isoDate);
  return addDays(isoDate, days);
}

/**
 * The UTC instant at which a wall clock in `timeZone` read `date` at `hh:mm`.
 *
 * ## Why the offset is resolved twice
 *
 * A zone's offset is a function of the *instant*, not of the date, so the offset
 * in force at the misread-as-UTC timestamp is not always the one in force at the
 * instant being solved for — the two differ across a DST cutover. The first pass
 * produces a candidate; the second asks what the offset actually was *there*.
 *
 * ## Why this is the whole of acceptance criterion 20
 *
 * A recurring task set to 09:00 must fire at 09:00 local on both sides of a DST
 * transition. Because the offset is resolved at the instant, 09:00 on
 * 2026-03-07 in `America/New_York` comes back as 14:00Z and 09:00 on 2026-03-09
 * as 13:00Z — nine in the morning, both times. Storing one instant and adding a
 * fixed 24-hour multiple would drift by an hour for half the year, which is the
 * version of this that passes review because it is right in October.
 *
 * ## What happens when the requested wall clock does not exist
 *
 * No verification step, unlike `startOfDayInZone` below — deliberately, because
 * for a *chosen* time of day there may be no right answer to verify against:
 * where a zone springs forward at 02:00, 02:30 never happens that day.
 *
 * The behaviour in that gap is deterministic and worth stating rather than
 * discovering. The refined candidate interprets the reading at the **pre**-
 * transition offset, so it lands in the last hour before the gap — up to an hour
 * earlier than asked for, and in a zone that springs forward *at midnight*
 * (`America/Havana`) that hour is late on the previous day. Measured on this
 * stack, not assumed: 00:30 on 2023-03-12 in Havana resolves to
 * `2023-03-12T04:30:00Z`, which reads 23:30 on the 11th.
 *
 * For a deadline that means becoming late up to an hour early, on one day a
 * year, in one zone, for a time that does not exist. `occurs_on` is unaffected —
 * it is a bare date and never passes through here. Verifying the candidate the
 * way `startOfDayInZone` does would be the wrong contract: local midnight always
 * exists somewhere in a local day, so there is a right answer to find; 02:30 on
 * a spring-forward day has none.
 *
 * This is phase 2's behaviour unchanged — `localInputToInstant` delegates here.
 */
export function instantFromWallClock(
  timeZone: string,
  date: CalendarDate,
  hour: number,
  minute: number,
  second = 0,
): Date {
  // The wall-clock reading, deliberately misread as a UTC instant. It is wrong
  // by exactly the zone's offset — the quantity being solved for.
  const asIfUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
  );
  const firstGuess = asIfUtc - zoneOffsetMs(timeZone, new Date(asIfUtc));
  const refined = asIfUtc - zoneOffsetMs(timeZone, new Date(firstGuess));

  return new Date(refined);
}

/**
 * The first UTC instant of `isoDate` in `timeZone`.
 *
 * Two candidates are produced and then filtered by the only test that actually
 * matters — does this instant fall on the requested local date? — with the
 * earliest survivor winning:
 *
 * - the normal case yields two identical candidates;
 * - an offset change between UTC midnight and local midnight yields two
 *   different valid ones, and the earlier is the true start (Auckland, above);
 * - a nonexistent local midnight yields one valid and one that has fallen back
 *   into the previous day, and the filter discards the wrong one (Havana).
 *
 * Verifying instead of trusting is what makes one short function cover all
 * three; the widely copied "resolve the offset twice and return" shortcut
 * quietly gets the third case wrong.
 */
export function startOfDayInZone(timeZone: string, isoDate: string): Date {
  const [year, month, day] = requireIsoDate(isoDate);

  // Local midnight's wall-clock reading, deliberately misread as if it were a
  // UTC instant. It is off by exactly the zone's offset — which is the quantity
  // we are about to solve for.
  const asIfUtc = Date.UTC(year, month - 1, day);

  const firstGuess = asIfUtc - zoneOffsetMs(timeZone, new Date(asIfUtc));
  const refined = asIfUtc - zoneOffsetMs(timeZone, new Date(firstGuess));

  const candidates = [firstGuess, refined].filter(
    (candidate) => todayInZone(timeZone, new Date(candidate)) === isoDate,
  );

  // Neither candidate landing on the date is not reachable with a real tz
  // database — it would take an offset change larger than a day. Preferring the
  // refined value keeps the function total rather than returning `undefined`
  // from `Math.min` of an empty list.
  if (candidates.length === 0) return new Date(refined);

  return new Date(Math.min(...candidates));
}

/**
 * The UTC instants bounding one local calendar day, `[start, end)`.
 *
 * Half-open on purpose: it is the interval SQL wants (`>= start and < end`), it
 * tiles with the neighbouring days exactly, and it removes the "is 23:59:59.999
 * good enough, or do I need .9999?" question that closed intervals invite.
 *
 * Round-trip property, asserted in the tests: for any instant `t` with
 * `start <= t < end`, `todayInZone(timeZone, t) === isoDate`.
 */
export function dayRangeInZone(timeZone: string, isoDate: string): DayRange {
  return {
    start: startOfDayInZone(timeZone, isoDate),
    // The start of the *next* local day, resolved independently — not
    // `start + 24h`, which is wrong by an hour on both DST transition days.
    end: startOfDayInZone(timeZone, addDaysToIsoDate(isoDate, 1)),
  };
}
