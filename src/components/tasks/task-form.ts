/**
 * The create/edit form, as values and payloads rather than as JSX.
 *
 * `task-dialog.tsx` holds `TaskFormValues` in state, renders one control per
 * field, and calls one of the two builders below on submit. Everything that
 * decides *what to send* lives here, so it can be unit-tested without a DOM and
 * without a tRPC provider — which is the whole of AGENTS.md's "validation and
 * predicates go in a lib file, not JSX".
 *
 * ## The schemas are imported, not restated
 *
 * `buildCreateInput` runs `taskInput` and `buildUpdatePatch` runs
 * `taskUpdateInput` — the exact schemas `src/lib/trpc/routers/task.ts` validates
 * with. The user therefore reads the same sentence before the round trip that
 * the server would have produced after it, and a rule can only be changed in
 * one place. Nothing here re-implements a length limit or a range.
 *
 * ## An edit sends a patch, not a replacement
 *
 * `task.update` takes "at least one field"; it does not take "the whole task".
 * Renaming a task therefore sends `{ id, title }` and nothing else. That is not
 * an optimisation — it is what stops an edit dialog opened at 09:00 and
 * submitted at 09:05 from writing back a stale status that a row control
 * changed in between.
 */

import { TASK_MESSAGES, taskInput, taskUpdateInput } from "@/lib/tasks/validators";

import { instantToLocalInput, localInputToInstant } from "./task-presentation";

import type { TaskStatus } from "@/lib/db/schema";
import type { Task, TaskClock, TaskCreateInput, TaskUpdateInput } from "./types";

/**
 * What the controls hold. All strings except progress, because that is what a
 * DOM control gives you — the conversion to the wire shape happens once, below,
 * rather than in six `onChange` handlers.
 *
 * `description` and `deadlineLocal` use `""` for "none", since an emptied
 * `<textarea>` and an emptied `<input type="datetime-local">` both produce it.
 * The schemas turn `""`/`null` into the single `null` the column stores.
 */
export interface TaskFormValues {
  title: string;
  description: string;
  /** `YYYY-MM-DD`, the calendar square the task sits on. */
  occursOn: string;
  /** `YYYY-MM-DDTHH:mm` as read on a clock in `TaskClock.timeZone`, or `""`. */
  deadlineLocal: string;
  status: TaskStatus;
  progressPct: number;
}

export interface TaskFormErrors {
  title?: string;
  description?: string;
  occursOn?: string;
  deadlineLocal?: string;
  status?: string;
  progressPct?: string;
  /** An issue that names no field — a whole-object rule such as the refine. */
  form?: string;
}

export type TaskFormResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: TaskFormErrors };

/**
 * Schema field → form field. Identical but for the deadline, whose control
 * holds a zoneless wall clock while the schema holds an instant.
 */
const FIELD_FOR_PATH: Record<string, keyof TaskFormErrors> = {
  title: "title",
  description: "description",
  occursOn: "occursOn",
  deadlineAt: "deadlineLocal",
  status: "status",
  progressPct: "progressPct",
};

/**
 * First issue per field wins.
 *
 * Zod reports every failure; a field can only show one message, and the first is
 * the one describing what the user did rather than a knock-on consequence.
 */
function errorsFromIssues(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): TaskFormErrors {
  const errors: TaskFormErrors = {};

  for (const issue of issues) {
    const field = FIELD_FOR_PATH[String(issue.path[0])] ?? "form";
    if (errors[field] === undefined) errors[field] = issue.message;
  }

  return errors;
}

/**
 * Seed values for the dialog.
 *
 * Creating seeds `occursOn` from `clock.today` — the *user's* day, resolved on
 * the server. A `new Date().toISOString().slice(0, 10)` here would seed the
 * browser's day, which is a different day for anyone east of the server after
 * their evening, and would differ between the SSR pass and hydration.
 *
 * Editing seeds the deadline through `instantToLocalInput`, so the control shows
 * the time the user set rather than the time their browser happens to be in.
 */
export function initialTaskFormValues(
  task: Task | null,
  clock: TaskClock,
): TaskFormValues {
  if (!task) {
    return {
      title: "",
      description: "",
      occursOn: clock.today,
      deadlineLocal: "",
      status: "todo",
      progressPct: 0,
    };
  }

  return {
    title: task.title,
    description: task.description ?? "",
    occursOn: task.occursOn,
    deadlineLocal: task.deadlineAt
      ? instantToLocalInput(task.deadlineAt, clock.timeZone)
      : "",
    status: task.status,
    progressPct: task.progressPct,
  };
}

/**
 * The form's values as the schemas want them: `""` collapsed to `null`, and the
 * wall clock resolved to an instant.
 *
 * A deadline that cannot be resolved comes back as `undefined` here and is
 * reported separately by the callers — feeding `null` to the schema would read
 * as "clear the deadline", which is the opposite of what a typo means.
 */
function wireValues(values: TaskFormValues, timeZone: string) {
  const deadlineAt = values.deadlineLocal
    ? localInputToInstant(values.deadlineLocal, timeZone)
    : null;

  return {
    title: values.title,
    description: values.description,
    occursOn: values.occursOn,
    deadlineAt,
    status: values.status,
    progressPct: values.progressPct,
  };
}

function deadlineTypo(values: TaskFormValues, timeZone: string): boolean {
  return (
    values.deadlineLocal !== "" &&
    localInputToInstant(values.deadlineLocal, timeZone) === null
  );
}

/** The payload for `task.create`, or the messages to show instead. */
export function buildCreateInput(
  values: TaskFormValues,
  timeZone: string,
): TaskFormResult<TaskCreateInput> {
  if (deadlineTypo(values, timeZone)) {
    return { ok: false, errors: { deadlineLocal: TASK_MESSAGES.deadlineInvalid } };
  }

  const parsed = taskInput.safeParse(wireValues(values, timeZone));
  if (!parsed.success) {
    return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  }

  // `parsed.data.deadlineAt` is a `Date` (the schema normalises), and the link
  // has no transformer — so it reaches the server as `toJSON()`'s ISO string,
  // which `z.iso.datetime({ offset: true })` accepts. `now` is deliberately not
  // sent: it is `z.date()`, which JSON cannot carry, and the server's own clock
  // is the right one for a value the client should not get a vote on.
  return { ok: true, data: parsed.data };
}

/**
 * The patch for `task.update` — only the fields that actually changed.
 *
 * `data: null` means the user submitted an untouched form. The caller closes the
 * dialog without a round trip; sending `{ id }` alone would be rejected by the
 * schema's own refine (`nothingToUpdate`), and rightly so.
 */
export function buildUpdatePatch(
  values: TaskFormValues,
  task: Task,
  timeZone: string,
): TaskFormResult<TaskUpdateInput | null> {
  if (deadlineTypo(values, timeZone)) {
    return { ok: false, errors: { deadlineLocal: TASK_MESSAGES.deadlineInvalid } };
  }

  const parsed = taskUpdateInput.safeParse({
    id: task.id,
    ...wireValues(values, timeZone),
  });
  if (!parsed.success) {
    return { ok: false, errors: errorsFromIssues(parsed.error.issues) };
  }

  const next = parsed.data;
  const patch: TaskUpdateInput = { id: task.id };
  let changed = false;

  if (next.title !== undefined && next.title !== task.title) {
    patch.title = next.title;
    changed = true;
  }
  if (next.description !== task.description) {
    patch.description = next.description;
    changed = true;
  }
  if (next.occursOn !== undefined && next.occursOn !== task.occursOn) {
    patch.occursOn = next.occursOn;
    changed = true;
  }

  // Compared as ISO strings because that is what the row carries: `toPublicTask`
  // serialises `deadline_at` with `toISOString()`, so the two spellings are
  // directly comparable and `Date` identity never enters into it.
  const nextDeadline = next.deadlineAt ? next.deadlineAt.toISOString() : null;
  if (nextDeadline !== task.deadlineAt) {
    patch.deadlineAt = nextDeadline;
    changed = true;
  }

  if (next.status !== undefined && next.status !== task.status) {
    patch.status = next.status;
    changed = true;
  }

  // Judged entirely on its own, and never against `status`. A task moved to
  // `done` in this same submit keeps whatever percentage it had — criterion 12,
  // and the reason `src/lib/tasks/progress.ts` refuses to import `status.ts`.
  if (next.progressPct !== undefined && next.progressPct !== task.progressPct) {
    patch.progressPct = next.progressPct;
    changed = true;
  }

  return { ok: true, data: changed ? patch : null };
}
