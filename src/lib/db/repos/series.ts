import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";

import { withUser, type UserClaims } from "@/lib/db/rls";
import { taskSeries, type TaskSeries } from "@/lib/db/schema";
import { serialize } from "@/lib/recurrence/serialize";
import type { RecurrenceRule } from "@/lib/recurrence/rule";

/**
 * The `task_series` repository — the only module that speaks Drizzle about
 * repeat rules.
 *
 * ============================================================================
 * EVERY FUNCTION HERE OPENS ITS OWN `withUser()`. `dbAdmin` DOES NOT APPEAR.
 * ============================================================================
 *
 * Same contract as `./occurrences.ts`, and for the same reason: a series carries
 * a title and notes, which is task data, and "nobody sees anybody else's tasks,
 * including admins" is enforced by RLS rather than by remembering to write a
 * `.where()`. Concentrating the queries in one module is what makes that
 * auditable as a unit. `occurrences.test.ts` has a source-level guard asserting
 * `dbAdmin` is not imported; this file has the same one.
 *
 * Three rules carried over verbatim from the occurrences repo:
 *
 * 1. **`claims` first, and the caller never supplies a `userId`.** `create()`
 *    takes the owner from `claims.sub`, so "create a series in someone else's
 *    list" is not an operation this module can express.
 *
 * 2. **Explicit `.where()` on `user_id` even though RLS already scopes the row
 *    set.** Redundant to the policy, not to the habit — and it keeps the
 *    `(user_id) where deleted_at is null` index obviously applicable at the call
 *    site rather than only through the policy's injected predicate.
 *
 * 3. **`updated_at` is never written here.** `task_series_touch_updated_at`
 *    (0005) maintains it. Application code that sets it is fighting a BEFORE
 *    trigger that will overwrite it anyway.
 *
 * And one that is specific to this table:
 *
 * 4. **`rrule` is serialised here, not accepted from the caller.** The typed
 *    columns and the RFC 5545 string have to describe the same rule, and the
 *    only way to guarantee that is for the single module that writes both to
 *    derive one from the other. A caller that could pass its own string could
 *    pass one that disagrees, and nothing downstream could tell which was meant.
 */

/** `user_id = <caller>`, the clause every query in this module carries. */
function ownedBy(claims: UserClaims): SQL {
  return eq(taskSeries.userId, claims.sub);
}

/** `deleted_at is null` — the soft delete, applied on every read. */
function live(): SQL {
  return isNull(taskSeries.deletedAt);
}

/**
 * `id = <row> and user_id = <caller>`, for the operations that name one series.
 *
 * Both columns, always. On `id` alone the statement would only be safe because
 * RLS narrows it — and "delete series 123" would become "delete anyone's series
 * 123" the moment a policy was dropped or the query ran from a path that is not
 * `withUser()`.
 */
function ownRow(claims: UserClaims, id: string): SQL {
  return and(eq(taskSeries.id, id), ownedBy(claims))!;
}

/** The rule columns, spread into an insert or an update. */
function ruleValues(rule: RecurrenceRule) {
  return {
    freq: rule.freq,
    interval: rule.interval,
    byweekday: [...rule.byweekday],
    monthMode: rule.monthMode,
    monthDay: rule.monthDay,
    nthWeek: rule.nthWeek,
    nthWeekday: rule.nthWeekday,
    endsMode: rule.endsMode,
    endsOn: rule.endsOn,
    endsCount: rule.endsCount,
    // Derived, never accepted — see rule 4 in the module header.
    rrule: serialize(rule),
  };
}

/** Fields a caller may set when creating a series. Note the absence of `userId`. */
export interface CreateSeriesInput {
  title: string;
  description?: string | null;
  /** A bare `YYYY-MM-DD` calendar day — a `date` column, never a `Date`. */
  startsOn: string;
  /** `HH:MM` wall clock, or null for "these occurrences have no deadline". */
  deadlineTime?: string | null;
  /**
   * The template lead, in minutes before the occurrence's deadline, or null for
   * no reminder. Copied onto an occurrence at materialisation and owned by the
   * row thereafter — the same rule `title` and `deadlineTime` follow.
   */
  reminderLeadMinutes?: number | null;
  rule: RecurrenceRule;
}

/**
 * Fields a caller may change.
 *
 * A **replacement**, not a patch, unlike `UpdateOccurrencePatch`. The rule is
 * one value — `normaliseRule` and `serialize` both take all ten fields together
 * — so a partial rule cannot be written without inventing the missing half.
 */
export type UpdateSeriesInput = CreateSeriesInput;

/**
 * Every live series the caller owns, newest first.
 *
 * Unpaginated, like `occurrences.listAll`: the count is bounded by how many
 * repeat rules one person writes, which is a much smaller number than how many
 * occurrences those rules produce.
 */
export async function listActive(claims: UserClaims): Promise<TaskSeries[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(taskSeries)
      .where(and(ownedBy(claims), live()))
      .orderBy(desc(taskSeries.createdAt), asc(taskSeries.id)),
  );
}

/**
 * One live series the caller owns, or `null`.
 *
 * `null` covers "no such series", "not yours" and "deleted" identically, because
 * from outside they are the same fact and should not be distinguishable —
 * telling a caller that a series exists but is not theirs confirms the existence
 * of another user's data.
 */
export async function findOwn(
  claims: UserClaims,
  id: string,
): Promise<TaskSeries | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .select()
      .from(taskSeries)
      .where(and(ownRow(claims, id), live()));

    return rows[0] ?? null;
  });
}

/** Create one series owned by the caller, and return the row the database wrote. */
export async function create(
  claims: UserClaims,
  input: CreateSeriesInput,
): Promise<TaskSeries> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .insert(taskSeries)
      .values({
        userId: claims.sub,
        title: input.title,
        description: input.description ?? null,
        startsOn: input.startsOn,
        deadlineTime: input.deadlineTime ?? null,
        reminderLeadMinutes: input.reminderLeadMinutes ?? null,
        ...ruleValues(input.rule),
      })
      .returning();

    // An INSERT the `task_series_insert_own` policy refuses raises rather than
    // returning nothing, so reaching here without a row is not a case to handle.
    return rows[0];
  });
}

/**
 * Replace one of the caller's series. Returns the updated row, or `null` when
 * none matched.
 *
 * **Writes nothing to `task_occurrence`.** That is the whole of acceptance
 * criterion 15: occurrences nobody has touched were never rows, so they follow
 * the new rule on the next read with nothing to delete; occurrences somebody has
 * touched *are* rows and keep everything they carry — including on a date the
 * new rule no longer names, where they show up as themselves. Re-materialising
 * here would be the one way to destroy work the criterion exists to protect.
 */
export async function update(
  claims: UserClaims,
  id: string,
  input: UpdateSeriesInput,
): Promise<TaskSeries | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .update(taskSeries)
      .set({
        title: input.title,
        description: input.description ?? null,
        startsOn: input.startsOn,
        deadlineTime: input.deadlineTime ?? null,
        reminderLeadMinutes: input.reminderLeadMinutes ?? null,
        ...ruleValues(input.rule),
      })
      .where(and(ownRow(claims, id), live()))
      .returning();

    return rows[0] ?? null;
  });
}

/**
 * Soft-delete one of the caller's series. `true` when a row moved.
 *
 * A soft delete rather than a `DELETE`, and this is the mechanism behind
 * acceptance criterion 17 rather than a general preference for tombstones:
 *
 *   - Untouched future occurrences vanish, because a deleted series is not
 *     expanded and they were never rows.
 *   - Recorded history survives untouched, because its rows still resolve their
 *     `series_id` — which a hard delete would cascade away (0005's FK).
 *
 * Neither half needs a job, and nothing writes to `task_occurrence`.
 *
 * `live()` is in the `where` so deleting twice reports `false` the second time
 * rather than silently re-stamping `deleted_at` and moving the tombstone.
 */
export async function softDelete(
  claims: UserClaims,
  id: string,
): Promise<boolean> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .update(taskSeries)
      .set({ deletedAt: new Date() })
      .where(and(ownRow(claims, id), live()))
      .returning({ id: taskSeries.id });

    return rows.length > 0;
  });
}
