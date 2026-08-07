/**
 * The expander: which calendar squares a rule names.
 *
 * ============================================================================
 * PURE. NO CLOCK, NO TIMEZONE, NO DATABASE. THE CALLER PASSES THE WINDOW.
 * ============================================================================
 *
 * This is the function acceptance criteria 13 and 16 are written against, and
 * it is deliberately the least clever module in the phase. It reads a rule and
 * a start date and returns `YYYY-MM-DD` strings. It never asks what day it is —
 * which is what lets "does `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` produce the
 * right twelve weeks" be a test with no mocking in it, and what keeps it honest
 * about criterion 19 (nothing under `src/components/**` decides what day it is,
 * and this is not the module that would help them).
 *
 * ## Two rules that are easy to get subtly wrong
 *
 * 1. **`COUNT` is counted from `startsOn`, never from the window.** Occurrence
 *    #7 of a `COUNT=10` series is the seventh occurrence whatever range you ask
 *    about. The loop therefore always starts at `startsOn` and *collects* what
 *    falls inside the window. An implementation that counts what it emits gives
 *    a different answer per page, which is the version of this bug that survives
 *    review because it looks like an optimisation.
 *
 * 2. **Dates that do not exist are skipped, not clamped.** `BYMONTHDAY=31`
 *    produces nothing in February; a yearly rule anchored on 29 February
 *    produces nothing in a common year. That is RFC 5545. Clamping to "the
 *    28th" would invent an occurrence the user never asked for, on a date they
 *    would then be nagged about.
 *
 * ## Termination
 *
 * `ends_mode: "never"` is genuinely infinite, so two bounds are built into the
 * function rather than left to the caller: `MAX_OCCURRENCES_PER_EXPANSION`
 * caps what comes back, and `MAX_PERIODS` caps how far it will walk to get
 * there. Both are properties of the function — a caller cannot forget them.
 */

import type { Weekday } from "@/lib/db/schema";

import {
  addDays,
  addMonths,
  compareIsoDates,
  daysBetween,
  daysInMonth,
  formatIsoDate,
  monthsBetween,
  nthWeekdayOfMonth,
  parseIsoDate,
  startOfIsoWeek,
  weekdayCode,
  WEEKDAY_OFFSET,
  type CalendarDate,
} from "./calendar";
import type { RecurrenceRule } from "./rule";

/**
 * The most dates one call will ever return.
 *
 * 366 is a year of a daily rule. Comfortably above the widest window
 * `src/lib/tasks/feed.ts` asks for (91 days), so in normal use the window is
 * what binds and this never fires; low enough that a runaway rule allocates
 * nothing interesting. It lives here, in the pure function, rather than at the
 * call site, so that "this returns at most N dates and always terminates" is a
 * property of `expand` and not a policy each caller has to remember.
 */
export const MAX_OCCURRENCES_PER_EXPANSION = 366;

/**
 * The most periods the loop will walk before giving up.
 *
 * A period is a day, a week, a month or a year depending on the frequency. In
 * practice the loop is bounded long before this by one of two things, which is
 * the point of `firstPeriod()` below:
 *
 *   - a rule that does **not** end after a count can be fast-forwarded straight
 *     to the window, so the walk is as long as the window (at most 366 days);
 *   - a rule that ends after a count cannot be fast-forwarded — `COUNT` is
 *     counted from `startsOn` and skipped months are not always occurrences —
 *     but `ends_count` is capped at 365 by the CHECK in 0005, so the walk stops
 *     itself.
 *
 * So this is a backstop for a rule that is somehow neither, not a working limit.
 * A series started in 1900 still lists correctly today; without the
 * fast-forward it would silently return nothing, which is exactly the sort of
 * quiet wrongness a cap is supposed to prevent rather than cause.
 */
export const MAX_PERIODS = 20_000;

/** The `[from, to]` calendar range a caller wants dates for. Both inclusive. */
export interface ExpansionWindow {
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  /** `YYYY-MM-DD`, inclusive. */
  to: string;
}

/**
 * The dates `rule` names, anchored at `startsOn`, that fall inside `window`.
 *
 * Ascending, distinct, and never more than `limit`. An unparseable `startsOn`
 * or window, or a rule whose end condition puts it entirely before the window,
 * returns an empty array rather than throwing — this runs inside a list read,
 * and a malformed stored rule should cost that series its rows, not the page.
 */
export function expand(
  rule: RecurrenceRule,
  startsOn: string,
  window: ExpansionWindow,
  limit: number = MAX_OCCURRENCES_PER_EXPANSION,
): string[] {
  const start = parseIsoDate(startsOn);
  if (!start || !parseIsoDate(window.from) || !parseIsoDate(window.to)) {
    return [];
  }

  const cap = Math.max(0, Math.min(limit, MAX_OCCURRENCES_PER_EXPANSION));
  if (cap === 0) return [];

  // The last date worth generating: the window's end, brought forward if the
  // rule stops sooner. Resolved once rather than tested twice per candidate.
  const lastDate =
    rule.endsMode === "on" && rule.endsOn
      ? minIsoDate(window.to, rule.endsOn)
      : window.to;

  if (compareIsoDates(lastDate, startsOn) < 0) return [];

  const results: string[] = [];
  // Occurrences the rule has produced since `startsOn`, whether or not they fell
  // inside the window. This is what `COUNT` is counted against.
  let produced = 0;

  const collect = (date: string): boolean => {
    // Before DTSTART is not part of the recurrence set at all — it does not
    // count toward COUNT and it is not returned. RFC 5545 §3.8.5.3.
    if (compareIsoDates(date, startsOn) < 0) return true;
    if (compareIsoDates(date, lastDate) > 0) return false;

    if (rule.endsMode === "after" && rule.endsCount != null) {
      if (produced >= rule.endsCount) return false;
    }
    produced += 1;

    if (compareIsoDates(date, window.from) >= 0) {
      results.push(date);
      if (results.length >= cap) return false;
    }

    return true;
  };

  // Where the walk begins. Zero unless the rule can be fast-forwarded — see
  // `firstPeriod`.
  const from = firstPeriod(rule, start, startsOn, window.from);

  switch (rule.freq) {
    case "daily":
      expandDaily(rule, startsOn, lastDate, from, collect);
      break;
    case "weekly":
      expandWeekly(rule, startsOn, lastDate, from, collect);
      break;
    case "monthly":
      expandMonthly(rule, start, lastDate, from, collect);
      break;
    case "yearly":
      expandYearly(rule, start, lastDate, from, collect);
      break;
  }

  return results;
}

/** `true` from the collector means "keep going". */
type Collect = (date: string) => boolean;

function minIsoDate(a: string, b: string): string {
  return compareIsoDates(a, b) <= 0 ? a : b;
}

/**
 * The first period index worth walking, so a long-running series does not have
 * to be stepped through one day at a time to reach the window.
 *
 * ## Why this is conditional rather than always on
 *
 * `ends_mode: "after"` counts occurrences from `startsOn`, so the walk has to
 * pass through every one of them to know when the rule stops — and the count
 * cannot be computed arithmetically, because a monthly rule on the 31st and a
 * yearly rule on 29 February both produce *fewer* occurrences than they have
 * periods. Fast-forwarding those would over-count and end the series early.
 *
 * For every other end mode `produced` is never read, so the periods before the
 * window carry no information and can be skipped outright. That is the case
 * where a series started years ago would otherwise walk thousands of steps.
 *
 * `floor` throughout, deliberately: landing one period *early* costs a few
 * wasted iterations, landing one late drops a real occurrence.
 */
function firstPeriod(
  rule: RecurrenceRule,
  start: CalendarDate,
  startsOn: string,
  windowFrom: string,
): number {
  if (rule.endsMode === "after") return 0;
  if (compareIsoDates(windowFrom, startsOn) <= 0) return 0;

  const target = parseIsoDate(windowFrom);
  if (!target) return 0;

  switch (rule.freq) {
    case "daily":
      return Math.max(
        0,
        Math.floor(daysBetween(startsOn, windowFrom) / rule.interval),
      );
    case "weekly": {
      const weeks =
        daysBetween(startOfIsoWeek(startsOn), startOfIsoWeek(windowFrom)) / 7;
      return Math.max(0, Math.floor(weeks / rule.interval));
    }
    case "monthly": {
      const months = monthsBetween(
        start.year,
        start.month,
        target.year,
        target.month,
      );
      return Math.max(0, Math.floor(months / rule.interval));
    }
    case "yearly":
      return Math.max(
        0,
        Math.floor((target.year - start.year) / rule.interval),
      );
  }
}

function expandDaily(
  rule: RecurrenceRule,
  startsOn: string,
  lastDate: string,
  from: number,
  collect: Collect,
): void {
  let date = addDays(startsOn, from * rule.interval);

  for (let period = from; period < from + MAX_PERIODS; period += 1) {
    if (compareIsoDates(date, lastDate) > 0) return;
    if (!collect(date)) return;
    date = addDays(date, rule.interval);
  }
}

/**
 * Weekly, anchored on the ISO week containing `startsOn`.
 *
 * `INTERVAL=2` means "every other week", and *which* weeks are the other ones is
 * decided by the week `startsOn` falls in — not by a count of emitted dates. So
 * the walk is over weeks, and each eligible week yields its selected days in
 * order; days before `startsOn` are simply not part of the set, which is why a
 * series starting on a Wednesday with `BYDAY=MO,WE` produces one date in its
 * first week and two in every week after.
 *
 * `WKST` is `MO` — RFC 5545's default and the only value this app produces. That
 * is baked into `startOfIsoWeek` and into `WEEKDAY_OFFSET`.
 */
function expandWeekly(
  rule: RecurrenceRule,
  startsOn: string,
  lastDate: string,
  from: number,
  collect: Collect,
): void {
  // An empty BYDAY means "the weekday DTSTART falls on", per RFC 5545.
  const days: readonly Weekday[] =
    rule.byweekday.length > 0 ? rule.byweekday : [weekdayCode(startsOn)];

  const anchor = startOfIsoWeek(startsOn);
  const step = rule.interval * 7;

  for (let period = from; period < from + MAX_PERIODS; period += 1) {
    const weekStart = addDays(anchor, period * step);
    // Every day in this week is at or after its Monday, so once the Monday is
    // past the end there is nothing left anywhere.
    if (compareIsoDates(weekStart, lastDate) > 0) return;

    for (const day of days) {
      if (!collect(addDays(weekStart, WEEKDAY_OFFSET[day]))) return;
    }
  }
}

function expandMonthly(
  rule: RecurrenceRule,
  start: CalendarDate,
  lastDate: string,
  from: number,
  collect: Collect,
): void {
  for (let period = from; period < from + MAX_PERIODS; period += 1) {
    const { year, month } = addMonths(
      start.year,
      start.month,
      period * rule.interval,
    );

    // The first of the month bounds every candidate it could produce.
    if (compareIsoDates(formatIsoDate({ year, month, day: 1 }), lastDate) > 0) {
      return;
    }

    const date = monthlyCandidate(rule, year, month);
    // `null` is a month the rule names no day in — February for BYMONTHDAY=31.
    // Skipped, and deliberately not counted: RFC 5545 says such a date is simply
    // not in the recurrence set, so it must not consume one of COUNT's slots.
    if (date && !collect(date)) return;
  }
}

function monthlyCandidate(
  rule: RecurrenceRule,
  year: number,
  month: number,
): string | null {
  if (rule.monthMode === "by_date") {
    if (rule.monthDay == null) return null;
    // Skipped, never clamped — see the header.
    if (rule.monthDay > daysInMonth(year, month)) return null;
    return formatIsoDate({ year, month, day: rule.monthDay });
  }

  if (rule.monthMode === "by_nth_weekday") {
    if (rule.nthWeekday == null || rule.nthWeek == null) return null;
    return nthWeekdayOfMonth(year, month, rule.nthWeekday, rule.nthWeek);
  }

  return null;
}

/**
 * Yearly: the same month and day as `startsOn`, every `interval` years.
 *
 * A series anchored on 29 February produces nothing in a common year. Skipped
 * rather than moved to the 28th or the 1st, for the reason in the header — and
 * not counted either, so `COUNT=4` from a leap-day start spans sixteen years and
 * names four real 29ths rather than four dates, most of which are wrong.
 */
function expandYearly(
  rule: RecurrenceRule,
  start: CalendarDate,
  lastDate: string,
  from: number,
  collect: Collect,
): void {
  for (let period = from; period < from + MAX_PERIODS; period += 1) {
    const year = start.year + period * rule.interval;
    if (
      compareIsoDates(formatIsoDate({ year, month: 1, day: 1 }), lastDate) > 0
    ) {
      return;
    }

    if (start.day <= daysInMonth(year, start.month)) {
      if (!collect(formatIsoDate({ year, month: start.month, day: start.day }))) {
        return;
      }
    }
  }
}
