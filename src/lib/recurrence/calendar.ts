/**
 * Calendar arithmetic, with no zone anywhere in it.
 *
 * ============================================================================
 * THIS FILE DOES NOT KNOW WHAT A TIMEZONE IS, AND MUST NOT LEARN.
 * ============================================================================
 *
 * `src/lib/time/` answers questions about *instants* — what day is it in Manila,
 * which UTC moment does local midnight fall on, what does 09:00 in New York mean
 * in March. This file answers questions about *squares on a calendar* — what is
 * three days after the 30th, how many days does February 2028 have, which date
 * is the last Friday of next month. The two are different problems and mixing
 * them is exactly the mistake acceptance criterion 20 punishes: an offset is a
 * function of an instant, and a calendar square has no instant.
 *
 * Every function here takes and returns bare `YYYY-MM-DD` strings and does its
 * arithmetic through `Date.UTC`, which is used purely as a vehicle for month
 * lengths and leap years. No local zone is ever consulted, so the answers do not
 * depend on where the process runs — which is what lets the recurrence engine be
 * unit-tested without mocking a clock.
 *
 * `src/lib/time/day-boundary.ts` sits on top of this and adds the zone.
 */

import { WEEKDAYS, type Weekday } from "@/lib/db/schema";

/** A date with no time and no zone, split into its three numbers. */
export interface CalendarDate {
  /** Four-digit calendar year. */
  year: number;
  /** 1–12, **not** the 0–11 that `Date` uses. */
  month: number;
  /** 1–31. */
  day: number;
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** `{ year, month, day }` rendered as `YYYY-MM-DD`. */
export function formatIsoDate(date: CalendarDate): string {
  const year = String(date.year).padStart(4, "0");
  const month = String(date.month).padStart(2, "0");
  const day = String(date.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * True for a triple naming a day that exists. `2026-02-30` does not.
 *
 * `Date.UTC` rolls overflow forward silently — month 13 becomes next January,
 * 30 February becomes 1 or 2 March — so the only way to reject an impossible
 * date is to build it and check it came back unchanged.
 */
export function isValidCalendarDate(
  year: number,
  month: number,
  day: number,
): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return false;
  }
  const built = new Date(Date.UTC(year, month - 1, day));
  return (
    built.getUTCFullYear() === year &&
    built.getUTCMonth() === month - 1 &&
    built.getUTCDate() === day
  );
}

/** A `YYYY-MM-DD` string as numbers, or `null` when it names no real day. */
export function parseIsoDate(value: string): CalendarDate | null {
  if (!ISO_DATE_PATTERN.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!isValidCalendarDate(year, month, day)) return null;
  return { year, month, day };
}

/** How many days are in that month. February knows about leap years. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the *next* month is the last day of this one.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Shift a date by whole days, staying in calendar space.
 *
 * DST never enters into it — this is not "add 24 hours", which is wrong twice a
 * year in any zone that observes a transition. It is "move N squares along the
 * calendar", which is the same answer everywhere. Invalid input is returned
 * unchanged rather than throwing, because every caller here has already
 * validated and the alternative is a throw from inside a list render.
 */
export function addDays(isoDate: string, days: number): string {
  const date = parseIsoDate(isoDate);
  if (!date) return isoDate;

  const shifted = new Date(
    Date.UTC(date.year, date.month - 1, date.day) + days * MS_PER_DAY,
  );
  return formatIsoDate({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/**
 * Shift a `(year, month)` pair by whole months, without a day to invalidate.
 *
 * Returned as a pair rather than a date precisely because the day is the caller's
 * problem: "the 31st, three months on" may name no day at all, and answering
 * that with a rolled-forward 1 March is how a rule silently gains an occurrence
 * its owner never asked for.
 */
export function addMonths(
  year: number,
  month: number,
  months: number,
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + months;
  return {
    year: Math.floor(zeroBased / 12),
    month: (((zeroBased % 12) + 12) % 12) + 1,
  };
}

/**
 * The day of the week, **0 = Monday**.
 *
 * Monday-based because RFC 5545's default `WKST` is `MO` and because
 * `WEEKDAYS` in the schema mirror is declared in that order — the index this
 * returns is directly an index into it. `Date`'s own `getUTCDay()` is
 * Sunday-based, which is the off-by-one that shifts every weekly rule by a day
 * if it is used raw.
 */
export function weekdayIndex(isoDate: string): number {
  const date = parseIsoDate(isoDate);
  if (!date) return 0;
  const sundayBased = new Date(
    Date.UTC(date.year, date.month - 1, date.day),
  ).getUTCDay();
  return (sundayBased + 6) % 7;
}

/** The RFC 5545 two-letter code for that date's weekday. */
export function weekdayCode(isoDate: string): Weekday {
  return WEEKDAYS[weekdayIndex(isoDate)];
}

/**
 * How many days past the Monday of its week each weekday sits.
 *
 * The inverse of `weekdayIndex`, precomputed: the weekly expander turns a set of
 * codes into dates once per week, and a lookup says what it means more plainly
 * than `WEEKDAYS.indexOf(day)` at the point of use. Monday is 0 because RFC
 * 5545's default `WKST` is `MO`.
 */
export const WEEKDAY_OFFSET: Record<Weekday, number> = Object.fromEntries(
  WEEKDAYS.map((day, index) => [day, index]),
) as Record<Weekday, number>;

/** The Monday of the ISO week containing `isoDate`. */
export function startOfIsoWeek(isoDate: string): string {
  return addDays(isoDate, -weekdayIndex(isoDate));
}

/**
 * The nth `weekday` of a month — "the second Tuesday", "the last Friday".
 *
 * `nth` is 1–4 counting forwards, or `-1` for the last. Returns `null` when the
 * month has no such day, which with 1–4 and -1 cannot happen (every month is at
 * least 28 days, so it holds at least four of every weekday) — the branch is
 * there so a future `nth = 5` gets a missing occurrence rather than a wrong one.
 */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: Weekday,
  nth: number,
): string | null {
  const target = WEEKDAYS.indexOf(weekday);
  if (target < 0) return null;

  const total = daysInMonth(year, month);

  if (nth < 0) {
    const lastIndex = weekdayIndex(formatIsoDate({ year, month, day: total }));
    // How far back from the end of the month the last such weekday sits.
    const back = (lastIndex - target + 7) % 7;
    const day = total - back + (nth + 1) * 7;
    return day >= 1 ? formatIsoDate({ year, month, day }) : null;
  }

  const firstIndex = weekdayIndex(formatIsoDate({ year, month, day: 1 }));
  const forward = (target - firstIndex + 7) % 7;
  const day = 1 + forward + (nth - 1) * 7;
  return day <= total ? formatIsoDate({ year, month, day }) : null;
}

/**
 * Whole days from `a` to `b`. Negative when `b` is earlier.
 *
 * Safe as plain millisecond division because both operands are built at UTC
 * midnight, where a day is always exactly 86 400 000 ms — the assumption that
 * makes this wrong in a zone with DST does not apply, because no zone is
 * involved.
 */
export function daysBetween(a: string, b: string): number {
  const from = parseIsoDate(a);
  const to = parseIsoDate(b);
  if (!from || !to) return 0;

  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      MS_PER_DAY,
  );
}

/** Whole months from `(aYear, aMonth)` to `(bYear, bMonth)`. */
export function monthsBetween(
  aYear: number,
  aMonth: number,
  bYear: number,
  bMonth: number,
): number {
  return (bYear - aYear) * 12 + (bMonth - aMonth);
}

/**
 * Order two calendar dates. Negative, zero or positive, like every comparator.
 *
 * A plain string comparison is correct for zero-padded `YYYY-MM-DD` and is what
 * this uses — the function exists so the *reason* it is correct is written down
 * once, instead of a reader wondering at each `a < b` whether the padding really
 * holds. It does: `parseIsoDate` rejects anything unpadded.
 */
export function compareIsoDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
