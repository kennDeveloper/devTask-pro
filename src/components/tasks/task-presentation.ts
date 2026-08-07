/**
 * How a task *reads* — the column list, the date strings, and the two
 * conversions between an absolute instant and the wall clock a person sets it
 * on.
 *
 * Pure functions only, no React. AGENTS.md puts anything reused, regex-based or
 * multi-condition in a lib file rather than in JSX, and everything here is at
 * least one of the three. It sits beside the components instead of in
 * `src/lib/tasks/` because it is *presentation*: `src/lib/tasks/` owns the
 * product rules (what "overdue" means, what a status is called), and this file
 * owns how those answers are spelled on a screen. Nothing here decides anything.
 *
 * ## Every formatter takes an explicit locale and zone. None reads the ambient ones.
 *
 * `new Intl.DateTimeFormat()` with no arguments uses the *host's* locale and
 * timezone, which is a different host on the server than in the browser. A
 * deadline formatted that way renders "6 Aug 2026, 23:00" during SSR and
 * "8/6/2026, 3:00 PM" after hydration — a React hydration error caused entirely
 * by a date string. So the locale is pinned to one value and the zone always
 * arrives as an argument, from `TaskClock`, which the server resolved.
 */

import {
  addDaysToIsoDate,
  instantFromWallClock,
} from "@/lib/time/day-boundary";
import { DATE_LOCALE, formatCalendarDate } from "@/lib/time/format-date";
import { toIsoDate, wallClockInZone } from "@/lib/time/user-tz";

export { formatCalendarDate };

/**
 * Pinned so the server and the browser produce byte-identical strings.
 *
 * `en-GB` rather than `en-US` for its day-first, unambiguous short form
 * ("6 Aug 2026") and its 24-hour clock — a deadline is a precise moment and
 * "11:00 PM" is one more thing to parse than "23:00".
 *
 * Shared with `src/lib/time/format-date.ts`, which is where the calendar-date
 * formatter moved when `src/lib/recurrence/labels.ts` became its second caller.
 */
const LOCALE = DATE_LOCALE;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type TaskColumnKey =
  | "task"
  | "day"
  | "deadline"
  | "status"
  | "progress"
  | "actions";

export interface TaskColumn {
  key: TaskColumnKey;
  label: string;
  /** True when the header is for screen readers only (an actions column). */
  labelHidden?: boolean;
  /** Width class for the matching skeleton cell, so loading mirrors loaded. */
  skeletonWidth: string;
  /** Applied to both the header cell and the skeleton cell. */
  className?: string;
}

/**
 * The table's columns, as data.
 *
 * Written once and consumed by the header, the skeleton and the empty row's
 * `colSpan`. The alternative — a hand-counted `colSpan={6}` next to a hand-written
 * header — is a column added in one place and a mis-spanned empty state in
 * another, and it only shows up on the screen nobody screenshots.
 */
const ALL_TASK_COLUMNS: readonly TaskColumn[] = [
  { key: "task", label: "Task", skeletonWidth: "w-56" },
  { key: "day", label: "Day", skeletonWidth: "w-20" },
  { key: "deadline", label: "Deadline", skeletonWidth: "w-28" },
  { key: "status", label: "Status", skeletonWidth: "w-24" },
  { key: "progress", label: "Progress", skeletonWidth: "w-24" },
  {
    key: "actions",
    label: "Actions",
    labelHidden: true,
    skeletonWidth: "w-14",
    className: "text-right",
  },
];

/**
 * The columns to render.
 *
 * `/today` scopes to a single day, so a Day column there would repeat the word
 * "Today" down the page — noise in the position the eye scans first. `/tasks`
 * and `/overdue` span days and need it.
 */
export function taskColumns(showDay: boolean): readonly TaskColumn[] {
  return showDay
    ? ALL_TASK_COLUMNS
    : ALL_TASK_COLUMNS.filter((column) => column.key !== "day");
}

// ---------------------------------------------------------------------------
// Calendar days (`occurs_on` — a date with no time and no zone)
// ---------------------------------------------------------------------------

/**
 * `formatCalendarDate` is re-exported from `src/lib/time/format-date.ts` at the
 * top of this file. It lives there because `src/lib/recurrence/labels.ts` needs
 * it too, and a `src/lib` module importing a component directory would point the
 * dependency arrow backwards. The re-export keeps every existing caller — and
 * every existing test — importing it from here.
 */

/**
 * The day a task sits on, named the way a person would name it.
 *
 * "Today" beats "6 Aug 2026" for the one date the user is standing on, and the
 * comparison is against `today` — the server-resolved day from `TaskClock` —
 * never against a fresh clock read. That is what keeps the label stable across
 * hydration and correct for a user whose zone is not the server's.
 */
export function dayLabel(isoDate: string, today: string): string {
  if (isoDate === today) return "Today";
  if (isoDate === addDaysToIsoDate(today, 1)) return "Tomorrow";
  if (isoDate === addDaysToIsoDate(today, -1)) return "Yesterday";
  return formatCalendarDate(isoDate);
}

// ---------------------------------------------------------------------------
// Deadlines (`deadline_at` — an absolute instant)
// ---------------------------------------------------------------------------

const deadlineFormatters = new Map<string, Intl.DateTimeFormat>();

function deadlineFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = deadlineFormatters.get(timeZone);
  if (cached) return cached;

  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      // "h23" rather than `hour12: false` — see the note in `user-tz.ts`; some
      // ICU builds render midnight as "24:00" under the latter.
      hourCycle: "h23",
    });
  } catch {
    // A zone this runtime cannot format would otherwise throw mid-render and
    // take out the whole list. A deadline shown in UTC is wrong by hours; a
    // blank page is wrong by everything.
    formatter = new Intl.DateTimeFormat(LOCALE, {
      timeZone: "UTC",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  }

  deadlineFormatters.set(timeZone, formatter);
  return formatter;
}

/**
 * `"2026-08-06T15:00:00.000Z"` in `Asia/Manila` → `"6 Aug 2026, 23:00"`.
 *
 * The zone is the *account holder's*, not the browser's. A user who travels
 * should see their deadlines where they set them, and — more to the point — the
 * server and the client must render the same string.
 */
export function formatDeadline(deadlineAt: string, timeZone: string): string {
  const instant = new Date(deadlineAt);
  if (Number.isNaN(instant.getTime())) return deadlineAt;
  return deadlineFormatter(timeZone).format(instant);
}

// ---------------------------------------------------------------------------
// <input type="datetime-local"> ⇄ an absolute instant
// ---------------------------------------------------------------------------

/**
 * `datetime-local` speaks wall clock with **no zone attached** — the control
 * hands back `"2026-08-06T23:00"` and means nothing more than "what the clock
 * said". `deadline_at` is a `timestamptz`, an instant. Converting between the
 * two requires a zone, and the only correct one is the account holder's:
 * `new Date("2026-08-06T23:00")` resolves against whatever zone the *browser*
 * is in, which is exactly the class of bug criterion 18 rules out.
 */
const LOCAL_INPUT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** An instant → the `datetime-local` value that reads it in `timeZone`. */
export function instantToLocalInput(
  deadlineAt: string,
  timeZone: string,
): string {
  const instant = new Date(deadlineAt);
  if (Number.isNaN(instant.getTime())) return "";

  const wall = wallClockInZone(timeZone, instant);
  const date = toIsoDate(wall);
  return `${date}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/**
 * A `datetime-local` value → the ISO instant it names in `timeZone`.
 *
 * Returns `null` for anything that is not a wall-clock reading, so the caller
 * can report it as a field error rather than send `Invalid Date` to the server.
 *
 * ## Why the offset is resolved twice
 *
 * A zone's offset is a function of the instant, not of the date, so the offset
 * in force at the misread-as-UTC timestamp is not always the one in force at the
 * instant we are solving for — the two differ across a DST cutover. The first
 * pass produces a candidate instant; the second asks what the offset actually
 * was *there*. `startOfDayInZone` in `src/lib/time/day-boundary.ts` does the
 * same thing for midnight and explains it at length.
 *
 * Unlike that function this one does not verify the result lands on the
 * requested wall clock, because for a user-typed time it may not be able to: on
 * a spring-forward day 02:30 simply does not exist in that zone. The refined
 * candidate resolves to the transition instant, which is the nearest real moment
 * to what was asked for — the best available answer, and one the user can see
 * and correct in the field they just typed into.
 *
 * The arithmetic itself moved to `instantFromWallClock` in
 * `src/lib/time/day-boundary.ts` when the recurrence engine needed the same
 * conversion for a series' `deadline_time` (criterion 20). This function now
 * owns only the parsing and the `null` contract; the offset resolution has one
 * implementation.
 */
export function localInputToInstant(
  local: string,
  timeZone: string,
): string | null {
  const match = LOCAL_INPUT_PATTERN.exec(local);
  if (!match) return null;

  const [year, month, day, hour, minute] = match.slice(1).map(Number);

  const instant = instantFromWallClock(timeZone, { year, month, day }, hour, minute);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}
