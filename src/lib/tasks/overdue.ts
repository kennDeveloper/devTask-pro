/**
 * Overdue, defined once.
 *
 * There are exactly two places this rule may be written: the SQL predicate in
 * `src/lib/db/repos/occurrences.ts` (`deadline_at < now() and status <> 'done'`)
 * and `isOverdue` below. Every other module — the /today grouping, the row
 * badge, the /overdue bucket — asks this function. A third definition inlined
 * into a component is how the list and the count start disagreeing on the same
 * screen.
 *
 * **Overdue is derived, never stored.** No column, no job, no invalidation.
 * Marking a task done (criterion 10) or moving its deadline into the future
 * (criterion 11) removes it from the bucket on the very next render, because
 * there is no cached answer to go stale.
 */

import { isDone } from "./status";

import type { TaskStatus } from "@/lib/db/schema";

/**
 * The two fields overdue actually depends on, and nothing else.
 *
 * Deliberately structural rather than `TaskOccurrence` or `PublicTask`: the
 * database row carries a `Date`, the tRPC link has no transformer so the client
 * receives an ISO string, and tests want to pass a literal. All three are the
 * same question. Accepting the narrow shape also lets the repo's fixture set be
 * shared with the SQL predicate's test (criterion 7) without either side
 * needing the other's row type.
 */
export interface OverdueTaskFields {
  deadlineAt: Date | string | null;
  status: TaskStatus;
}

/**
 * True when `task` is past its deadline and not finished, as of `now`.
 *
 * `now` is a parameter and never `new Date()`. A predicate that reads the
 * ambient clock cannot be tested at a boundary, and — more importantly here —
 * it would be called during render on the client, which is precisely the
 * hydration mismatch criterion 19 exists to prevent. The caller decides what
 * "now" is, and on a server-rendered page that decision is made once.
 *
 * A null deadline is never overdue however old `occurs_on` gets (criterion 8).
 * That is the same three-valued-logic outcome the SQL gets for free from
 * `deadline_at < now()`, spelled out here because JavaScript has no NULL.
 */
export function isOverdue(task: OverdueTaskFields, now: Date): boolean {
  const { deadlineAt } = task;
  if (deadlineAt == null) return false;
  if (isDone(task.status)) return false;

  // `Date.parse` yields NaN for anything it cannot read, and every comparison
  // against NaN is false — so a malformed deadline reports "not overdue"
  // rather than throwing inside a list render or, worse, nagging the user
  // about a date that does not exist.
  const deadline =
    deadlineAt instanceof Date ? deadlineAt.getTime() : Date.parse(deadlineAt);

  return deadline < now.getTime();
}
