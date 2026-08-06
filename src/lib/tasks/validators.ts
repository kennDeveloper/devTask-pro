/**
 * The boundary schema for a task, and the copy that goes with it.
 *
 * Same job as `src/lib/auth/validators.ts` does for the auth forms, and the
 * same shape: field schemas and message constants as pure exports, nothing
 * inline in JSX. `src/lib/trpc/routers/task.ts` validates every mutation with
 * the schemas below, and the create/edit dialog reuses the very same ones, so
 * the sentence a user reads before the round trip is the sentence the server
 * would have produced.
 *
 * **Zod is the polite half; the database is the boundary.** Every rule here
 * mirrors a `check` constraint in
 * `supabase/migrations/0004_task_occurrence.sql` — title 1..200 after trimming,
 * description ≤ 2000, status in three values, progress 0..100. If the two ever
 * disagree the constraint wins, loudly, which is the correct failure. What Zod
 * buys is a message naming the field instead of a Postgres error string.
 *
 * It imports the bounds rather than restating them: `TASK_STATUSES` from the
 * schema mirror, `PROGRESS_MIN`/`PROGRESS_MAX` from `./progress`.
 */

import { z } from "zod";

import { TASK_STATUSES } from "@/lib/db/schema";

import { PROGRESS_MAX, PROGRESS_MIN } from "./progress";

/** Mirrors `check (length(btrim(title)) between 1 and 200)`. */
export const TITLE_MAX_LENGTH = 200;

/** Mirrors `check (description is null or length(description) <= 2000)`. */
export const DESCRIPTION_MAX_LENGTH = 2000;

/** The exact strings the dialog renders. Tests assert against these. */
export const TASK_MESSAGES = {
  titleRequired: "Give the task a title.",
  titleTooLong: `Use ${TITLE_MAX_LENGTH} characters or fewer.`,
  descriptionTooLong: `Use ${DESCRIPTION_MAX_LENGTH} characters or fewer.`,
  occursOnInvalid: "Choose a valid date.",
  deadlineInvalid: "Choose a valid deadline.",
  statusInvalid: "Choose a status from the list.",
  progressOutOfRange: `Progress runs from ${PROGRESS_MIN} to ${PROGRESS_MAX}.`,
  progressNotWhole: "Use a whole number.",
  nothingToUpdate: "Provide at least one field to update.",
} as const;

// ---------------------------------------------------------------------------
// Calendar dates
// ---------------------------------------------------------------------------

const CALENDAR_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True for a `YYYY-MM-DD` string naming a day that exists.
 *
 * `occurs_on` is a bare `date` read as a string (see the note on the column in
 * `schema.ts`) — it must never become a `Date`, because attaching a time and a
 * zone to a calendar square is what makes the square move when the process
 * does. So it is validated as text.
 *
 * The pattern alone is not enough: `2026-02-31` matches it and Postgres would
 * reject the insert. Round-tripping through `Date.UTC` catches that, and UTC is
 * used purely as an arithmetic vehicle here — no local zone is consulted, so
 * the answer does not depend on where this runs.
 */
export function isCalendarDate(value: string): boolean {
  if (!CALENDAR_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

export const taskIdField = z.uuid();

/**
 * Trimmed before length is judged, exactly as `length(btrim(title))` does —
 * otherwise "   " passes a `min(1)` here and fails the constraint there.
 */
export const taskTitleField = z
  .string({ error: TASK_MESSAGES.titleRequired })
  .trim()
  .min(1, { error: TASK_MESSAGES.titleRequired })
  .max(TITLE_MAX_LENGTH, { error: TASK_MESSAGES.titleTooLong });

/**
 * Optional notes, where **absent and empty mean different things**.
 *
 * `undefined` is "do not touch this field", which is what an update payload
 * that omits it means. `null` is "clear it". An emptied `<textarea>` submits
 * `""`, and storing an empty string alongside NULL would give the column two
 * spellings of "no notes" that every later `is null` check would have to know
 * about — so `""` normalises to `null` here, once, rather than in each caller.
 *
 * The transform preserves `undefined` deliberately: collapsing it to `null`
 * would turn every partial update into an accidental wipe of the description.
 */
export const taskDescriptionField = z
  .string()
  .trim()
  .max(DESCRIPTION_MAX_LENGTH, { error: TASK_MESSAGES.descriptionTooLong })
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return value ? value : null;
  });

/** The calendar day, as a string. Optional on create — see `taskInput`. */
export const taskOccursOnField = z
  .string({ error: TASK_MESSAGES.occursOnInvalid })
  .refine(isCalendarDate, { error: TASK_MESSAGES.occursOnInvalid })
  .optional();

/**
 * The moment the task becomes late, normalised to a `Date`.
 *
 * Accepts a `Date` *or* an ISO instant, because both really arrive: the tRPC
 * link has no transformer configured, so a `Date` the client passes is
 * `JSON.stringify`d to an ISO string on the way over and only ever reaches the
 * server as text — while a server-side caller (a test, a later job) naturally
 * holds a `Date`. Rejecting one of the two would mean the caller doing the
 * conversion, and doing it differently in each place.
 *
 * An offset is required, not optional: `deadline_at` is `timestamptz`, and a
 * zoneless "2026-08-06T23:00" would be interpreted against whatever zone the
 * parser felt like — which is exactly the class of bug criterion 18 is about.
 * `undefined` and `null` keep the distinct meanings described on
 * `taskDescriptionField`.
 */
export const taskDeadlineAtField = z
  .union([
    z.date({ error: TASK_MESSAGES.deadlineInvalid }),
    z.iso.datetime({ offset: true, error: TASK_MESSAGES.deadlineInvalid }),
  ])
  .nullable()
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return value === null ? null : new Date(value);
  });

/** Optional on both create and update — the column defaults to `'todo'`. */
export const taskStatusField = z
  .enum(TASK_STATUSES, { error: TASK_MESSAGES.statusInvalid })
  .optional();

/**
 * Progress, judged entirely on its own.
 *
 * There is no cross-field rule here and there must not be one: a `done` task at
 * 40% is valid input and stays at 40% (criterion 12). `.int()` matters because
 * the column is an `integer` — a silently rounded 42.5 would read back as a
 * value the user never chose.
 */
export const taskProgressField = z
  .number({ error: TASK_MESSAGES.progressOutOfRange })
  .int({ error: TASK_MESSAGES.progressNotWhole })
  .min(PROGRESS_MIN, { error: TASK_MESSAGES.progressOutOfRange })
  .max(PROGRESS_MAX, { error: TASK_MESSAGES.progressOutOfRange })
  .optional();

// ---------------------------------------------------------------------------
// The schemas the router validates with
// ---------------------------------------------------------------------------

/** Everything but the title is optional, and every default lives in the SQL. */
const taskFields = {
  description: taskDescriptionField,
  occursOn: taskOccursOnField,
  deadlineAt: taskDeadlineAtField,
  status: taskStatusField,
  progressPct: taskProgressField,
};

/**
 * Input for `task.create`.
 *
 * `occursOn` is optional on purpose: when it is absent the server resolves
 * *today in the caller's timezone* (criterion 6) via `src/lib/time/`. It cannot
 * be defaulted here, because a schema has no idea which user is asking — and a
 * `new Date()` in this file would quietly default it to the *server's* day,
 * which is the exact mistake that criterion exists to rule out.
 */
export const taskInput = z.object({
  title: taskTitleField,
  ...taskFields,
});

/** Derived from `taskFields` so a field added there cannot be forgotten here. */
const UPDATABLE_FIELDS: readonly string[] = [
  "title",
  ...Object.keys(taskFields),
];

/**
 * Input for `task.update` — a patch, not a replacement.
 *
 * Every field is optional so a row control can send `{ id, status }` without
 * having to round-trip the title it never showed. The `refine` mirrors
 * `profileUpdateInput`'s: an update naming nothing but an id is a caller bug,
 * and answering it with a no-op success hides that.
 *
 * `id` is validated even though RLS already confines the write to the caller's
 * own rows — a malformed uuid should be a 400 naming the field, not a Postgres
 * cast error surfacing as a 500.
 */
export const taskUpdateInput = z
  .object({
    id: taskIdField,
    title: taskTitleField.optional(),
    ...taskFields,
  })
  .refine(
    (value) =>
      UPDATABLE_FIELDS.some(
        (field) => (value as Record<string, unknown>)[field] !== undefined,
      ),
    { error: TASK_MESSAGES.nothingToUpdate },
  );

export type TaskInput = z.output<typeof taskInput>;
export type TaskUpdateInput = z.output<typeof taskUpdateInput>;
