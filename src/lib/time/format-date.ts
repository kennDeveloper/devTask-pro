/**
 * Rendering a bare calendar date, identically on the server and in the browser.
 *
 * Phase 2 put this in `src/components/tasks/task-presentation.ts`, which was the
 * only consumer. Phase 3 added a second — `describeRule` in
 * `src/lib/recurrence/labels.ts` renders a rule's "until" date — and a module
 * under `src/lib/**` importing a component directory points the dependency arrow
 * the wrong way. So the formatter moved down here and
 * `task-presentation.ts` delegates; there is still one implementation.
 *
 * ## The locale and the zone are both pinned, and neither is the host's
 *
 * `new Intl.DateTimeFormat()` with no arguments uses the *host's* locale and
 * timezone, which is a different host during SSR than during hydration. A date
 * formatted that way renders "31 Dec 2026" on the server and "12/31/2026" in the
 * browser — a React hydration error caused entirely by a date string.
 *
 * `en-GB` for its day-first, unambiguous short form ("31 Dec 2026"). UTC because
 * the value being formatted is a calendar square with no instant in it, and
 * building it at UTC midnight is the only way to render it without a zone
 * shifting it a day.
 */

/** Pinned so the server and the browser produce byte-identical strings. */
export const DATE_LOCALE = "en-GB";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const CALENDAR_FORMAT = new Intl.DateTimeFormat(DATE_LOCALE, {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** `"2026-08-06"` → `"6 Aug 2026"`. Unparseable input is passed through. */
export function formatCalendarDate(isoDate: string): string {
  if (!ISO_DATE_PATTERN.test(isoDate)) return isoDate;
  const [year, month, day] = isoDate.split("-").map(Number);
  return CALENDAR_FORMAT.format(new Date(Date.UTC(year, month - 1, day)));
}
