/**
 * What the three task statuses mean to a person, as pure values.
 *
 * The statuses themselves are not declared here. `TASK_STATUSES` lives in
 * `src/lib/db/schema.ts` next to the `check (status in (...))` it mirrors, and
 * that CHECK is the actual authority — a second literal list in this file would
 * be a fourth place to forget when a status is added. What this module owns is
 * everything the database has no opinion about: the words, the option order,
 * and the one-click affordance the row control needs.
 *
 * Nothing here imports React or a database connection, so a component that
 * renders a status is a renderer over these values rather than a place where
 * the string "in_progress" gets spelled out again.
 */

import { TASK_STATUSES, type TaskStatus } from "@/lib/db/schema";

/**
 * The exact words the UI shows. Sentence case, not Title Case — these appear
 * inside `<option>`s and badges, mid-sentence, and "In Progress" reads like a
 * proper noun.
 */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

/**
 * Labels an arbitrary string, passing an unrecognised one straight through.
 *
 * Same contract as `accountStatusLabel` in `profile-form.ts`, for the same
 * reason: a row that arrives with a status this build has never heard of should
 * render *something* honest rather than "undefined". The CHECK constraint makes
 * that near-impossible today; a deploy racing a migration makes it possible.
 */
export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status as TaskStatus] ?? status;
}

/** True for a value the `task_occurrence_status_check` constraint accepts. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * `<option>` data for the status control, in the order work actually flows.
 *
 * Built from `TASK_STATUSES` rather than written out, so a status added to the
 * migration and the mirror appears in the control without a third edit.
 */
export const TASK_STATUS_OPTIONS: ReadonlyArray<{
  value: TaskStatus;
  label: string;
}> = TASK_STATUSES.map((value) => ({
  value,
  label: TASK_STATUS_LABELS[value],
}));

/**
 * The one place "is this finished" is spelled.
 *
 * `isOverdue` needs it, the row styling needs it, and the /today grouping needs
 * it. Comparing to the literal `"done"` in each of those is how the three
 * quietly disagree later — one of them ends up also treating 100% progress as
 * finished, which is exactly the coupling criterion 12 forbids.
 */
export function isDone(status: TaskStatus): boolean {
  return status === "done";
}

/**
 * Where a single click on the status control lands next.
 *
 * **This is an affordance, not a state machine.** Status is freely reversible —
 * `done → in_progress` is a legitimate move a user makes when they realise
 * something was not finished after all — so the cycle wraps rather than
 * stopping at `done`, and no `canTransition()` exists to be consulted. The
 * `<select>` on the row offers all three regardless; this only decides what the
 * quick toggle advances to, and every destination it can reach is reachable by
 * hand as well.
 */
const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export function nextStatus(status: TaskStatus): TaskStatus {
  return STATUS_CYCLE[status];
}
