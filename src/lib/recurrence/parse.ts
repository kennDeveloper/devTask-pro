/**
 * An RFC 5545 `RRULE` value back into a rule.
 *
 * The inverse of `serialize.ts`, and the half that has to be forgiving:
 * `serialize` is the only thing that writes `task_series.rrule` today, but a
 * string can also arrive from a hand-written migration, from a paste, or — the
 * case this is really for — from the `rrule` package if it is ever adopted. So
 * parts are accepted **in any order**, keys and values are case-insensitive, a
 * leading `RRULE:` is tolerated, and both spellings of "the last Friday" read.
 *
 * What it will not do is guess. A string naming a frequency this app does not
 * support, or a `BYMONTHDAY` of 45, comes back as `null` rather than as a rule
 * with a plausible-looking default in it — because the caller can tell the user
 * their rule did not parse, and cannot tell them their rule quietly became a
 * different one.
 *
 * The round-trip property `parse(serialize(rule)) === rule` is asserted over the
 * full option matrix in `parse.test.ts`; it is acceptance criterion 6.
 */

import { NTH_WEEKS, type NthWeek, type Weekday } from "@/lib/db/schema";

import { isMonthMode, isWeekday, normaliseRule, type RecurrenceRule } from "./rule";
import { fromRfcDate } from "./serialize";
import { parseIsoDate } from "./calendar";

/** `BYDAY=-1FR` — the offset-prefixed spelling the `rrule` package emits. */
const OFFSET_WEEKDAY = /^([+-]?\d{1,2})(MO|TU|WE|TH|FR|SA|SU)$/;

function parts(value: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const chunk of value.split(";")) {
    const at = chunk.indexOf("=");
    if (at <= 0) continue;
    const key = chunk.slice(0, at).trim().toUpperCase();
    const raw = chunk.slice(at + 1).trim();
    if (key) map.set(key, raw);
  }

  return map;
}

function positiveInt(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > 0 ? parsed : null;
}

function nthWeek(value: string | undefined): NthWeek | null {
  if (value === undefined) return null;
  if (!/^[+-]?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return (NTH_WEEKS as readonly number[]).includes(parsed)
    ? (parsed as NthWeek)
    : null;
}

/**
 * The weekday codes in `BYDAY`, and any offset prefix that came with them.
 *
 * Returns `null` — rather than dropping the offender — for a list containing
 * anything that is not a weekday, so `BYDAY=MO,XX` fails the whole parse instead
 * of silently becoming "every Monday".
 */
function byDay(
  value: string | undefined,
): { days: Weekday[]; offset: NthWeek | null } | null {
  if (value === undefined) return { days: [], offset: null };

  const days: Weekday[] = [];
  let offset: NthWeek | null = null;

  for (const token of value.split(",")) {
    const code = token.trim().toUpperCase();
    if (isWeekday(code)) {
      days.push(code);
      continue;
    }

    const prefixed = OFFSET_WEEKDAY.exec(code);
    if (!prefixed) return null;

    const parsedOffset = nthWeek(prefixed[1]);
    if (parsedOffset === null) return null;
    // Two different offsets in one BYDAY is a rule this app cannot express.
    if (offset !== null && offset !== parsedOffset) return null;

    offset = parsedOffset;
    days.push(prefixed[2] as Weekday);
  }

  return { days, offset };
}

/**
 * An `RRULE` value as a rule, or `null` if it names something unsupported.
 *
 * The result is normalised, so fields the frequency does not use come back
 * cleared — which means `parse` can never produce a value the `task_series`
 * cross-column CHECKs would refuse.
 */
export function parse(value: string): RecurrenceRule | null {
  if (typeof value !== "string") return null;

  const body = value.trim().replace(/^RRULE:/i, "");
  if (!body) return null;

  const map = parts(body);

  const freq = map.get("FREQ")?.toLowerCase();
  if (
    freq !== "daily" &&
    freq !== "weekly" &&
    freq !== "monthly" &&
    freq !== "yearly"
  ) {
    return null;
  }

  // Absent means 1 (the RFC default); present but not a positive integer is an
  // error, not a reason to fall back to it.
  const rawInterval = map.get("INTERVAL");
  const interval = rawInterval === undefined ? 1 : positiveInt(rawInterval);
  if (interval === null) return null;

  const days = byDay(map.get("BYDAY"));
  if (days === null) return null;

  // BYSETPOS wins over an offset carried on BYDAY, because it is the spelling
  // `serialize` emits. They agree in every string this app writes.
  const setpos = map.has("BYSETPOS") ? nthWeek(map.get("BYSETPOS")) : null;
  if (map.has("BYSETPOS") && setpos === null) return null;
  const nth = setpos ?? days.offset;

  const rawMonthDay = map.get("BYMONTHDAY");
  const monthDay = rawMonthDay === undefined ? null : positiveInt(rawMonthDay);
  if (rawMonthDay !== undefined && (monthDay === null || monthDay > 31)) {
    return null;
  }

  // ---- the end condition -------------------------------------------------
  //
  // UNTIL and COUNT are mutually exclusive in RFC 5545, and a string carrying
  // both describes two different rules. Neither present means "never".
  const rawUntil = map.get("UNTIL");
  const rawCount = map.get("COUNT");
  if (rawUntil !== undefined && rawCount !== undefined) return null;

  let endsMode: RecurrenceRule["endsMode"] = "never";
  let endsOn: string | null = null;
  let endsCount: number | null = null;

  if (rawUntil !== undefined) {
    // The DATE-TIME forms (`20261231T000000Z`) are tolerated by taking the date
    // half: `starts_on` is DATE-valued, so the time carries no information here,
    // and refusing it would reject a perfectly clear rule from another calendar.
    endsOn = fromRfcDate(rawUntil.slice(0, 8));
    if (!endsOn || !parseIsoDate(endsOn)) return null;
    endsMode = "on";
  } else if (rawCount !== undefined) {
    endsCount = positiveInt(rawCount);
    if (endsCount === null) return null;
    endsMode = "after";
  }

  // ---- the monthly mode --------------------------------------------------
  //
  // Inferred from which parts are present rather than stored, because RFC 5545
  // has no "mode" — it has BYMONTHDAY or it has a positioned BYDAY.
  let monthMode: RecurrenceRule["monthMode"] = null;
  let nthWeekday: Weekday | null = null;

  if (freq === "monthly") {
    if (monthDay !== null) {
      monthMode = "by_date";
    } else if (nth !== null && days.days.length === 1) {
      monthMode = "by_nth_weekday";
      nthWeekday = days.days[0];
    } else {
      // Monthly with neither is legal RFC 5545 — it means "the day of the month
      // DTSTART falls on" — but `task_series` has no column for that and 0005
      // requires a mode, so it is out of scope rather than silently reinvented.
      return null;
    }
    if (!isMonthMode(monthMode)) return null;
  }

  return normaliseRule({
    freq,
    interval,
    byweekday: freq === "weekly" ? days.days : [],
    monthMode,
    monthDay: monthMode === "by_date" ? monthDay : null,
    nthWeek: monthMode === "by_nth_weekday" ? nth : null,
    nthWeekday,
    endsMode,
    endsOn,
    endsCount,
  });
}
