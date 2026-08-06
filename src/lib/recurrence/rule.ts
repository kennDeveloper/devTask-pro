/**
 * The repeat rule as a value: its shape, its defaults, and its normal form.
 *
 * The rule is stored as typed columns *and* as an RFC 5545 string
 * (`serialize.ts`), and this is the type both agree on. Nothing here reads a
 * clock, touches a database or knows about a timezone — the whole recurrence
 * engine is pure, which is what makes acceptance criteria 13, 16 and 20
 * ordinary unit tests rather than something you observe in October.
 *
 * The value vocabulary — the four frequencies, the seven weekday codes, the two
 * monthly modes, the three end modes — is imported from `src/lib/db/schema.ts`
 * rather than restated, because each mirrors a `check (col in (...))` in
 * `supabase/migrations/0005_task_series.sql` and that CHECK is the authority.
 */

import {
  ENDS_MODES,
  MONTH_MODES,
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
  type EndsMode,
  type MonthMode,
  type NthWeek,
  type RecurrenceFrequency,
  type Weekday,
} from "@/lib/db/schema";

import { weekdayCode } from "./calendar";

/**
 * A repeat rule, exactly as `task_series` stores it.
 *
 * Fields irrelevant to the current `freq` are `null` or empty rather than
 * carrying a stale value — see `normaliseRule`, and the `task_series_*_check`
 * constraints in 0005 that refuse a row where they do not.
 *
 * `startsOn` is deliberately **not** part of this type. It is the series' anchor
 * (RFC 5545's `DTSTART`), not part of the `RRULE` value, and keeping it out is
 * what lets `expand()` take it as an explicit argument instead of a rule
 * carrying its own start.
 */
export interface RecurrenceRule {
  freq: RecurrenceFrequency;
  /** "every N". 1 means every one. */
  interval: number;
  /**
   * WEEKLY only, and empty for every other frequency. An empty array on a weekly
   * rule means "the weekday `startsOn` falls on", per RFC 5545 — the editor
   * never produces one, but `expand()` honours it.
   */
  byweekday: readonly Weekday[];
  /** MONTHLY only. */
  monthMode: MonthMode | null;
  /** `by_date` only: 1–31. A month too short for it produces no occurrence. */
  monthDay: number | null;
  /** `by_nth_weekday` only: 1–4, or -1 for "last". */
  nthWeek: NthWeek | null;
  /** `by_nth_weekday` only. */
  nthWeekday: Weekday | null;
  endsMode: EndsMode;
  /** `ends_mode: "on"` only — inclusive, as `YYYY-MM-DD`. */
  endsOn: string | null;
  /** `ends_mode: "after"` only. Counted from `startsOn`, never from a window. */
  endsCount: number | null;
}

/** What a brand-new rule looks like before anybody touches the editor. */
export function defaultRule(startsOn: string): RecurrenceRule {
  return {
    freq: "weekly",
    interval: 1,
    // Seeded from the start date so the first thing the editor renders already
    // describes a real rule, rather than one that names no days.
    byweekday: [weekdayCode(startsOn)],
    monthMode: null,
    monthDay: null,
    nthWeek: null,
    nthWeekday: null,
    endsMode: "never",
    endsOn: null,
    endsCount: null,
  };
}

function isOneOf<T extends string>(
  values: readonly T[],
  candidate: unknown,
): candidate is T {
  return typeof candidate === "string" && (values as readonly string[]).includes(candidate);
}

export function isRecurrenceFrequency(
  value: unknown,
): value is RecurrenceFrequency {
  return isOneOf(RECURRENCE_FREQUENCIES, value);
}

export function isWeekday(value: unknown): value is Weekday {
  return isOneOf(WEEKDAYS, value);
}

export function isMonthMode(value: unknown): value is MonthMode {
  return isOneOf(MONTH_MODES, value);
}

export function isEndsMode(value: unknown): value is EndsMode {
  return isOneOf(ENDS_MODES, value);
}

/**
 * Clear every field the current frequency and end mode do not use.
 *
 * ## Why this exists rather than trusting the caller
 *
 * The editor is a form. A user picks Weekly, ticks Monday and Wednesday, then
 * changes their mind and picks Monthly — and the two weekdays are still sitting
 * in React state. Sending them writes a monthly series carrying a `BYDAY` the
 * expander ignores, at which point the typed columns and the serialised `rrule`
 * describe different rules and only one of them is right.
 *
 * 0005 refuses such a row outright (`task_series_weekly_days_check` and
 * friends), so without this the user's reward for changing their mind is a
 * constraint violation. Normalising is the polite half of the same rule, applied
 * once, on the way in.
 *
 * Weekdays are additionally **sorted into week order and de-duplicated**, so two
 * rules that name the same days serialise to the same string and compare equal.
 * Without it `BYDAY=WE,MO` and `BYDAY=MO,WE` are two spellings of one rule.
 */
export function normaliseRule(rule: RecurrenceRule): RecurrenceRule {
  const weekly = rule.freq === "weekly";
  const monthly = rule.freq === "monthly";
  const byDate = monthly && rule.monthMode === "by_date";
  const byNth = monthly && rule.monthMode === "by_nth_weekday";

  return {
    freq: rule.freq,
    interval: Math.max(1, Math.trunc(rule.interval) || 1),
    byweekday: weekly ? sortWeekdays(rule.byweekday) : [],
    monthMode: monthly ? (rule.monthMode ?? "by_date") : null,
    monthDay: byDate ? rule.monthDay : null,
    nthWeek: byNth ? rule.nthWeek : null,
    nthWeekday: byNth ? rule.nthWeekday : null,
    endsMode: rule.endsMode,
    endsOn: rule.endsMode === "on" ? rule.endsOn : null,
    endsCount: rule.endsMode === "after" ? rule.endsCount : null,
  };
}

/** Week order (Monday first) and no duplicates. See `normaliseRule`. */
export function sortWeekdays(days: readonly Weekday[]): Weekday[] {
  return WEEKDAYS.filter((day) => days.includes(day));
}

/**
 * Structural equality, for deciding whether a rule actually changed.
 *
 * Used by the editor to avoid sending a no-op update, and by the round-trip
 * property test. Both operands should be normalised first — this compares
 * values, and `{ byweekday: ["WE","MO"] }` is genuinely a different value from
 * `{ byweekday: ["MO","WE"] }` until `normaliseRule` has had them.
 */
export function rulesEqual(a: RecurrenceRule, b: RecurrenceRule): boolean {
  return (
    a.freq === b.freq &&
    a.interval === b.interval &&
    a.byweekday.length === b.byweekday.length &&
    a.byweekday.every((day, index) => day === b.byweekday[index]) &&
    a.monthMode === b.monthMode &&
    a.monthDay === b.monthDay &&
    a.nthWeek === b.nthWeek &&
    a.nthWeekday === b.nthWeekday &&
    a.endsMode === b.endsMode &&
    a.endsOn === b.endsOn &&
    a.endsCount === b.endsCount
  );
}
