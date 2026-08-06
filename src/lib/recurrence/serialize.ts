/**
 * A rule as an RFC 5545 `RRULE` value.
 *
 * ## Why the string exists at all when the columns already hold the rule
 *
 * Two reasons, both stated in `docs/gsd/devtask-pro-v1.md`. It is the
 * interchange format — anything that speaks calendars can read it — and it is
 * what keeps adopting the `rrule` npm package an *additive* change later rather
 * than a migration: the value already in the column is the value that package
 * takes. Owning a small expander today costs one file and zero dependencies;
 * owning a non-standard rule format would cost a data migration to get out of.
 *
 * ## Derived, never input
 *
 * `task_series.rrule` is produced from the typed columns by this function and by
 * nothing else. A caller that wrote the string directly could put a rule in it
 * that the columns do not describe, and there would be no way to tell which of
 * the two was meant.
 *
 * ## What is deliberately absent
 *
 * - **`DTSTART`.** It is not part of an `RRULE` value; it is the series'
 *   `starts_on`, passed alongside. Serialising it here would put the same fact
 *   in two places.
 * - **`WKST`.** RFC 5545 defaults it to `MO`, which is also Google Calendar's
 *   default and the only value this editor can produce. Emitting a constant
 *   invites a reader to think it varies.
 * - **`INTERVAL=1`.** The RFC default. Omitting it keeps the common string
 *   short and means two spellings of "every week" cannot both exist.
 */

import type { RecurrenceRule } from "./rule";

/**
 * Part order. Not required by RFC 5545 — a parser must accept any order, and
 * `parse()` does — but a canonical order means one rule has exactly one
 * spelling, which is what lets the round-trip property be an equality rather
 * than a set comparison.
 */
const PART_ORDER = [
  "FREQ",
  "UNTIL",
  "COUNT",
  "INTERVAL",
  "BYMONTHDAY",
  "BYDAY",
  "BYSETPOS",
] as const;

/** `"2026-12-31"` → `"20261231"`, RFC 5545's DATE form. */
export function toRfcDate(isoDate: string): string {
  return isoDate.replace(/-/g, "");
}

/** `"20261231"` → `"2026-12-31"`. Anything else comes back as `null`. */
export function fromRfcDate(value: string): string | null {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * The rule as an `RRULE` value — `"FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"`.
 *
 * `UNTIL` is emitted as a bare `YYYYMMDD` because the series' `DTSTART` is
 * DATE-valued (`starts_on` is a `date`). RFC 5545 requires `UNTIL` to match
 * `DTSTART`'s value type, so a UTC date-time here would be malformed — and the
 * `Z`-suffixed form is what most examples show, which is exactly why it is worth
 * writing down that it would be wrong for this schema.
 */
export function serialize(rule: RecurrenceRule): string {
  const parts = new Map<string, string>();

  parts.set("FREQ", rule.freq.toUpperCase());

  if (rule.endsMode === "on" && rule.endsOn) {
    parts.set("UNTIL", toRfcDate(rule.endsOn));
  } else if (rule.endsMode === "after" && rule.endsCount != null) {
    parts.set("COUNT", String(rule.endsCount));
  }

  if (rule.interval !== 1) {
    parts.set("INTERVAL", String(rule.interval));
  }

  if (rule.freq === "weekly" && rule.byweekday.length > 0) {
    parts.set("BYDAY", rule.byweekday.join(","));
  }

  if (rule.freq === "monthly") {
    if (rule.monthMode === "by_date" && rule.monthDay != null) {
      parts.set("BYMONTHDAY", String(rule.monthDay));
    } else if (
      rule.monthMode === "by_nth_weekday" &&
      rule.nthWeekday != null &&
      rule.nthWeek != null
    ) {
      // `BYDAY=FR;BYSETPOS=-1` rather than the equally valid `BYDAY=-1FR`.
      // Both spell "the last Friday"; this one keeps BYDAY holding nothing but
      // weekday codes, so the weekly and monthly cases read the same part the
      // same way. `parse()` accepts either, because the other spelling is what
      // the `rrule` package emits.
      parts.set("BYDAY", rule.nthWeekday);
      parts.set("BYSETPOS", String(rule.nthWeek));
    }
  }

  return PART_ORDER.filter((key) => parts.has(key))
    .map((key) => `${key}=${parts.get(key)}`)
    .join(";");
}
