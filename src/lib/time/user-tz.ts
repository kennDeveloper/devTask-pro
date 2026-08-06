/**
 * Reading the clock in somebody else's timezone.
 *
 * Every "what day is it?" question in the app goes through here, and the answer
 * is always the *account holder's* day — `profiles.timezone` — never the
 * server's and never the browser's. Two acceptance criteria hang on that:
 *
 * - **18.** A task due 23:00 in `Asia/Manila` is not overdue at 22:00 local,
 *   whatever region the server happens to run in.
 * - **19.** The "today" boundary resolves *identically* on the server and in the
 *   browser, so SSR and hydration agree and there is no flash of a different
 *   day.
 *
 * ## Why every function takes `now`
 *
 * Nothing in this file calls `new Date()` or `Date.now()`. That is the entire
 * mechanism behind criterion 19: the day is decided **once**, in a server
 * component that has already loaded the profile, and the resulting `YYYY-MM-DD`
 * string is handed to the client as a prop. A client component that read the
 * ambient clock could not agree with the server by construction — the two reads
 * happen at different instants, in different processes, and around midnight
 * they disagree. An injected `now` also makes the awkward cases (23:59:59.999,
 * a DST cutover) ordinary unit tests instead of something you wait until
 * October to observe.
 *
 * ## Why `Intl` and not a date library
 *
 * `Intl.DateTimeFormat` with a `timeZone` option is backed by the ICU tz
 * database that ships with Node and every browser. It is the only mechanism
 * available without a dependency that knows a zone's offset *at a given
 * instant* — which is the thing that actually matters, because offsets are not
 * constants. `America/Los_Angeles` is −08:00 in January and −07:00 in July, and
 * any arithmetic that treats a zone as a fixed number of hours is wrong twice a
 * year. `Asia/Kolkata` (+05:30) and `Asia/Kathmandu` (+05:45) break naive
 * hour-based arithmetic year-round.
 */

import { UTC, isKnownTimeZone } from "@/lib/profile-form";

/** A calendar date with no time and no zone, as `YYYY-MM-DD`. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A wall-clock reading: what a clock on the wall in that zone showed. */
export interface ZonedWallClock {
  /** Four-digit calendar year. */
  year: number;
  /** 1–12, **not** the 0–11 that `Date` uses. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  /** 0–59. */
  minute: number;
  /** 0–59. Sub-second precision is not available from `Intl`. */
  second: number;
}

function buildFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    // `hourCycle: "h23"` rather than `hour12: false`. They are *not*
    // interchangeable: with `hour12: false` some ICU versions render midnight
    // as hour "24" rather than "00", which silently shifts a computed date by a
    // day. "h23" pins the 00–23 cycle the rest of this file assumes.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/**
 * `Intl.DateTimeFormat` construction is the expensive part — the cheap part is
 * formatting with one you already have. Zones are a tiny, bounded set (one per
 * signed-in user), so caching them for the process lifetime costs nothing and
 * removes the allocation from every row of every list. `null` caches a zone the
 * runtime rejected, so a bad value costs one `try`/`catch` rather than one per
 * call.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat | null>();

/** The last-resort formatter. Every runtime with `Intl` at all accepts "UTC". */
const utcFormatter = buildFormatter(UTC);

function tryFormatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached !== undefined) return cached;

  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = buildFormatter(timeZone);
  } catch {
    // `Intl.DateTimeFormat` throws `RangeError` on a zone it does not know.
    formatter = null;
  }

  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * The zone to actually use, given whatever was stored.
 *
 * An unrecognised zone falls back to `UTC` instead of throwing. The value here
 * comes from a database column, and a zone that has rotted between the day it
 * was saved and the day it is read should show the wrong day by a few hours,
 * not take down the task list with a 500.
 *
 * ## Why this asks two questions and not one
 *
 * The first is `isKnownTimeZone` from `profile-form.ts` — deliberately the same
 * set `profileUpdateInput` enforces on write, so "a zone this app accepts" has
 * one definition rather than two that drift. It is also a plain set lookup,
 * which is the common case and costs nothing.
 *
 * The second exists because that set is **not portable across runtimes**, and
 * this module has to produce the same answer on the server and in the browser
 * (criterion 19). `Intl.supportedValuesOf("timeZone")` returns whatever
 * identifiers the host engine's CLDR data considers primary, and engines
 * disagree — measured on this project's Node 22 / ICU 77 the list contains
 * `Asia/Calcutta`, `Asia/Katmandu`, `Europe/Kiev` and `Asia/Saigon`, and
 * **not** their modern renamings `Asia/Kolkata`, `Asia/Kathmandu`,
 * `Europe/Kyiv`, `Asia/Ho_Chi_Minh`. Browsers that have shipped the ECMA-402
 * time-zone canonicalization change report the modern spellings instead. Gate
 * purely on the list and an Indian user's day boundary silently becomes UTC's —
 * off by five and a half hours — on whichever side of the wire has the older
 * list.
 *
 * So: if the list does not recognise the zone, ask the tz database itself by
 * trying to build a formatter. Both engines share that database even when they
 * disagree about which spellings to enumerate, which is what makes the two
 * sides agree. Only a zone *neither* question accepts becomes UTC.
 *
 * This is a read-side accommodation and does not widen what may be *saved* —
 * the router still validates against the set alone. Which leaves a known,
 * separate defect for whoever owns the settings form: on this Node,
 * `profileUpdateInput` **rejects** `Asia/Kolkata`, so a browser that prefills
 * the modern spelling produces a form that cannot be submitted. Reading is
 * robust to it; writing is not. Fixing that means widening the validator, which
 * is a decision about the write boundary and is not made here.
 *
 * One alias is worth naming: `"UTC"` itself. `supportedValuesOf` omits it while
 * `profiles.timezone` defaults to exactly `'UTC'`, which is the whole reason
 * `profile-form.ts` adds it back by hand. Without that, every brand-new account
 * would reach UTC by way of "unknown zone" rather than by way of "that is its
 * zone" — the same answer for the wrong reason, and only by luck.
 */
export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return UTC;
  if (isKnownTimeZone(timeZone)) return timeZone;
  return tryFormatterFor(timeZone) ? timeZone : UTC;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // `resolveTimeZone` only ever returns a zone this runtime can format, or UTC.
  return tryFormatterFor(resolveTimeZone(timeZone)) ?? utcFormatter;
}

/** What a clock in `timeZone` showed at `instant`. */
export function wallClockInZone(
  timeZone: string,
  instant: Date,
): ZonedWallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const wall: ZonedWallClock = {
    year: 0,
    month: 0,
    day: 0,
    hour: 0,
    minute: 0,
    second: 0,
  };

  for (const part of parts) {
    // `formatToParts` interleaves "literal" parts (the "/" and ":" separators)
    // and their order is locale-dependent — which is why we read by `type`
    // rather than by position, and why the locale above is pinned to a fixed
    // one instead of the ambient default.
    switch (part.type) {
      case "year":
        wall.year = Number(part.value);
        break;
      case "month":
        wall.month = Number(part.value);
        break;
      case "day":
        wall.day = Number(part.value);
        break;
      case "hour":
        wall.hour = Number(part.value);
        break;
      case "minute":
        wall.minute = Number(part.value);
        break;
      case "second":
        wall.second = Number(part.value);
        break;
    }
  }

  return wall;
}

/** `{ year, month, day }` rendered as `YYYY-MM-DD`. */
export function toIsoDate(
  wall: Pick<ZonedWallClock, "year" | "month" | "day">,
): string {
  const year = String(wall.year).padStart(4, "0");
  const month = String(wall.month).padStart(2, "0");
  const day = String(wall.day).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The current calendar date in `timeZone`, as `YYYY-MM-DD`.
 *
 * This is *the* definition of "today" for the whole app. At 22:00 on the 15th
 * in `Asia/Manila` this returns `"2024-01-15"` even though the server's own
 * clock has already rolled over to the 16th — which is criterion 18 stated as
 * a function.
 */
export function todayInZone(timeZone: string, now: Date): string {
  return toIsoDate(wallClockInZone(timeZone, now));
}

/** True for a well-formed, real calendar date — `2024-02-30` is neither. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  // `Date.UTC` silently rolls overflow forward (month 13 → next January,
  // Feb 30 → Mar 1), so the only way to reject an impossible date is to build
  // it and check it came back unchanged.
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

/**
 * How far `timeZone` was ahead of UTC at `instant`, in milliseconds.
 * `Asia/Manila` → `+28800000`; `America/Los_Angeles` → `-28800000` in winter,
 * `-25200000` in summer; `Asia/Kolkata` → `+19800000`.
 *
 * Derived by asking what the wall clock read and treating that reading as if it
 * were UTC: the gap between the two *is* the offset. Sub-second precision is
 * discarded first because `Intl` only reports whole seconds — without the
 * truncation the offset would come back a few hundred milliseconds off for any
 * instant that is not exactly on a second, and those milliseconds would land
 * straight in a day boundary.
 */
export function zoneOffsetMs(timeZone: string, instant: Date): number {
  const wall = wallClockInZone(timeZone, instant);
  const wallAsUtc = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsUtc - wholeSeconds;
}
