import { TRPCError } from "@trpc/server";
import { z } from "zod";

import type { TaskOccurrence } from "@/lib/db/schema";
import * as occurrences from "@/lib/db/repos/occurrences";
import {
  taskIdField,
  taskInput,
  taskUpdateInput,
} from "@/lib/tasks/validators";
import { todayInZone } from "@/lib/time/user-tz";

import { activeProcedure, router } from "../server";

/**
 * The task router.
 *
 * Three rules hold across every procedure here, and each is load-bearing:
 *
 * 1. **`activeProcedure`, never `protectedProcedure`.** A `pending`, `rejected` or
 *    `suspended` account is authenticated but must not reach application data.
 *    `profile.get` is the deliberate exception in this codebase — the gate screens
 *    need it to explain themselves — and nothing here is analogous.
 *
 * 2. **No Drizzle, and no `dbAdmin`.** Every query goes through
 *    `src/lib/db/repos/occurrences.ts`, which is the only module that touches the
 *    table. This file cannot leak data it does not own because it has no way to
 *    ask for it.
 *
 * 3. **The caller's identity comes from `ctx.user`, never from the input.** There is
 *    no `userId` field in any schema in `src/lib/tasks/validators.ts`; ownership is
 *    taken from the verified session and handed to the repo as claims.
 */

/**
 * The claims the repo needs, taken from the verified session.
 *
 * `ctx.user` is populated by `buildContext` from `supabase.auth.getUser()`, which
 * validates the JWT against the auth server rather than trusting its contents —
 * so `sub` here is a fact, not a claim the client made about itself.
 */
function claimsFor(ctx: { user: { id: string; email?: string } }) {
  return { sub: ctx.user.id, email: ctx.user.email };
}

/**
 * A JSON-safe view of a task row.
 *
 * The tRPC link has **no transformer** (see `src/lib/trpc/client.tsx`), so a `Date`
 * crosses the wire as a string no matter what the inferred type promises. Returning
 * the row directly would give the client a type claiming `Date` and a value holding
 * `string` — a mismatch that type-checks perfectly and fails at the first
 * `.getTime()`. Serialising here keeps the inferred type honest.
 *
 * `occursOn` is already a bare `YYYY-MM-DD` string (the column is `mode: "string"`)
 * and is passed through untouched — converting it to a `Date` would attach a time
 * and a zone to a value that has neither, which is the whole reason it is a `date`.
 *
 * `userId` is dropped: the caller is the owner by construction, so it carries no
 * information and only invites client code to start filtering on it.
 */
function toPublicTask(task: TaskOccurrence) {
  return {
    id: task.id,
    seriesId: task.seriesId,
    title: task.title,
    description: task.description,
    occursOn: task.occursOn,
    deadlineAt: task.deadlineAt?.toISOString() ?? null,
    status: task.status,
    progressPct: task.progressPct,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export type PublicTask = ReturnType<typeof toPublicTask>;

/**
 * `now` is accepted as an optional input rather than read from the server clock.
 *
 * Not for testing convenience: it lets the caller pin one instant for a render, so
 * a page that asks for both "today" and "overdue" judges both against the same
 * moment. Two independent `new Date()` calls a few milliseconds apart can put a
 * task in neither bucket. Absent, the server's clock is used — which is correct,
 * because "overdue" is an absolute comparison against a `timestamptz` and has
 * nothing to do with anyone's timezone.
 */
const nowInput = z.object({ now: z.date().optional() });

export const taskRouter = router({
  /** Every task the caller owns, newest day first. */
  list: activeProcedure.query(async ({ ctx }) =>
    (await occurrences.listAll(claimsFor(ctx))).map(toPublicTask),
  ),

  /**
   * The caller's tasks for one calendar day.
   *
   * `occursOn` is optional, and its absence means *today in the caller's own
   * timezone* — resolved here, on the server, from `ctx.profile.timezone`. The
   * client is never asked what day it is: that is criterion 19, and letting the
   * browser decide is precisely how SSR and hydration end up disagreeing.
   */
  listForDay: activeProcedure
    .input(nowInput.extend({ occursOn: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const day =
        input.occursOn ??
        todayInZone(ctx.profile.timezone, input.now ?? new Date());

      return (await occurrences.listForDay(claimsFor(ctx), day)).map(
        toPublicTask,
      );
    }),

  /**
   * The derived overdue bucket — past its deadline and not finished.
   *
   * Not filtered by day, and not a stored flag: the predicate lives in
   * `occurrences.overdueCondition` and is evaluated on read, so marking a task
   * done or moving its deadline forward takes it out of this list on the very
   * next query with no job and no invalidation step (criteria 10 and 11).
   */
  listOverdue: activeProcedure
    .input(nowInput)
    .query(async ({ ctx, input }) =>
      (
        await occurrences.listOverdue(claimsFor(ctx), input.now ?? new Date())
      ).map(toPublicTask),
    ),

  /**
   * Create a one-off task.
   *
   * `seriesId` is not settable and is absent from the schema — a one-off is
   * defined by having none, and phase 3 will create series rows through their own
   * path rather than by letting a client assert membership.
   */
  create: activeProcedure
    .input(taskInput.and(nowInput))
    .mutation(async ({ ctx, input }) => {
      const { now, ...task } = input;

      const created = await occurrences.create(claimsFor(ctx), {
        ...task,
        // Same rule as `listForDay`: the user's day, resolved server-side. A task
        // created at 23:30 in Manila belongs to that Manila day, not to whichever
        // day it happens to be in UTC.
        occursOn: task.occursOn ?? todayInZone(ctx.profile.timezone, now ?? new Date()),
      });

      return toPublicTask(created);
    }),

  /**
   * Patch a task. Absent fields are left alone; an explicit `null` clears one.
   *
   * A `null` return from the repo means RLS matched no row — the task belongs to
   * someone else, or never existed. Both are `NOT_FOUND` rather than `FORBIDDEN`:
   * telling a caller that a task exists but is not theirs would confirm the
   * existence of another user's data, which is exactly what this application
   * promises not to do.
   */
  update: activeProcedure
    .input(taskUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;

      const updated = await occurrences.update(claimsFor(ctx), id, patch);
      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      return toPublicTask(updated);
    }),

  /** Delete a task. Hard delete — see the plan; `deleted_at` belongs to series. */
  remove: activeProcedure
    .input(z.object({ id: taskIdField }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await occurrences.remove(claimsFor(ctx), input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      return { id: input.id };
    }),
});
