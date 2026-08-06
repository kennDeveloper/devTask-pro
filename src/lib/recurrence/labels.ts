/**
 * What a repeat rule is *called*, as pure values.
 *
 * Same split as `src/lib/tasks/status.ts`: the values themselves live in the
 * schema mirror next to the CHECK constraints that are their authority, and this
 * file owns the words, the option order and the one-line summary. Nothing here
 * imports React, so a component that renders a rule is a renderer over these
 * values rather than a place where "by_nth_weekday" gets spelled out again.
 *
 * `describeRule` in particular has to be shared: the editor shows it as a
 * preview of what is about to be saved, and the list shows it on the repeat
 * button so a user knows what a row belongs to without opening anything. Two
 * copies would eventually describe the same rule two different ways on one
 * screen.
 */

import {
  ENDS_MODES,
  MONTH_MODES,
  NTH_WEEKS,
  RECURRENCE_FREQUENCIES,
  WEEKDAYS,
  type EndsMode,
  type MonthMode,
  type NthWeek,
  type RecurrenceFrequency,
  type Weekday,
} from "@/lib/db/schema";

import { formatCalendarDate } from "@/lib/time/format-date";

import type { RecurrenceRule } from "./rule";

/** Sentence case, because these appear inside `<option>`s and mid-sentence. */
export const FREQUENCY_LABELS: Record<RecurrenceFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
};

/**
 * The unit after "every N" — singular at 1, plural above it.
 *
 * "Every 1 weeks" is the kind of thing that survives a whole release because
 * everybody reads past it, so the plural is decided here rather than with a
 * ternary at the call site.
 */
export function intervalUnitLabel(
  freq: RecurrenceFrequency,
  interval: number,
): string {
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[
    freq
  ];
  return interval === 1 ? unit : `${unit}s`;
}

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  MO: "Monday",
  TU: "Tuesday",
  WE: "Wednesday",
  TH: "Thursday",
  FR: "Friday",
  SA: "Saturday",
  SU: "Sunday",
};

/** Two letters for the picker's toggles, where seven full names do not fit. */
export const WEEKDAY_SHORT_LABELS: Record<Weekday, string> = {
  MO: "Mo",
  TU: "Tu",
  WE: "We",
  TH: "Th",
  FR: "Fr",
  SA: "Sa",
  SU: "Su",
};

export const MONTH_MODE_LABELS: Record<MonthMode, string> = {
  by_date: "On a day of the month",
  by_nth_weekday: "On a weekday of the month",
};

export const NTH_WEEK_LABELS: Record<NthWeek, string> = {
  1: "First",
  2: "Second",
  3: "Third",
  4: "Fourth",
  "-1": "Last",
};

export const ENDS_MODE_LABELS: Record<EndsMode, string> = {
  never: "Never",
  on: "On a date",
  after: "After a number of times",
};

/** `<option>` data, built from the constants so a new value needs no third edit. */
export const FREQUENCY_OPTIONS = RECURRENCE_FREQUENCIES.map((value) => ({
  value,
  label: FREQUENCY_LABELS[value],
}));

export const MONTH_MODE_OPTIONS = MONTH_MODES.map((value) => ({
  value,
  label: MONTH_MODE_LABELS[value],
}));

export const ENDS_MODE_OPTIONS = ENDS_MODES.map((value) => ({
  value,
  label: ENDS_MODE_LABELS[value],
}));

export const NTH_WEEK_OPTIONS = NTH_WEEKS.map((value) => ({
  value,
  label: NTH_WEEK_LABELS[value],
}));

export const WEEKDAY_OPTIONS = WEEKDAYS.map((value) => ({
  value,
  label: WEEKDAY_LABELS[value],
  short: WEEKDAY_SHORT_LABELS[value],
}));

/** The days part of a weekly rule — "Mon, Wed" — or "" when it names none. */
function weekdaysPhrase(days: readonly Weekday[]): string {
  return days.map((day) => WEEKDAY_LABELS[day].slice(0, 3)).join(", ");
}

/** The recurring half: "Every 2 weeks on Mon, Wed". */
function repeatPhrase(rule: RecurrenceRule): string {
  const every =
    rule.interval === 1
      ? `Every ${intervalUnitLabel(rule.freq, 1)}`
      : `Every ${rule.interval} ${intervalUnitLabel(rule.freq, rule.interval)}`;

  if (rule.freq === "weekly" && rule.byweekday.length > 0) {
    return `${every} on ${weekdaysPhrase(rule.byweekday)}`;
  }

  if (rule.freq === "monthly") {
    if (rule.monthMode === "by_date" && rule.monthDay != null) {
      return `${every} on day ${rule.monthDay}`;
    }
    if (
      rule.monthMode === "by_nth_weekday" &&
      rule.nthWeek != null &&
      rule.nthWeekday != null
    ) {
      const nth = NTH_WEEK_LABELS[rule.nthWeek].toLowerCase();
      return `${every} on the ${nth} ${WEEKDAY_LABELS[rule.nthWeekday]}`;
    }
  }

  return every;
}

/** The ending half: "", ", until 31 Dec 2026", ", 10 times". */
function endsPhrase(rule: RecurrenceRule): string {
  if (rule.endsMode === "on" && rule.endsOn) {
    return `, until ${formatCalendarDate(rule.endsOn)}`;
  }
  if (rule.endsMode === "after" && rule.endsCount != null) {
    return `, ${rule.endsCount} ${rule.endsCount === 1 ? "time" : "times"}`;
  }
  return "";
}

/**
 * One line describing the rule, for the editor's preview and the list's repeat
 * button — "Every 2 weeks on Mon, Wed, 10 times".
 *
 * Deliberately not the `rrule` string. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` is
 * the interchange format and means nothing to the person who wrote the rule; it
 * belongs in the column, not on a button.
 */
export function describeRule(rule: RecurrenceRule): string {
  return `${repeatPhrase(rule)}${endsPhrase(rule)}`;
}
