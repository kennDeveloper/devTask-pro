import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as occurrences from "@/lib/db/repos/occurrences";
import * as tagsRepo from "@/lib/db/repos/tags";
import * as feed from "@/lib/tasks/feed";
import { taskFiltersInput } from "@/lib/tasks/filter-validators";
import { tagIdsField } from "@/lib/tasks/tag-validators";
import { parseOccurrenceRef } from "@/lib/tasks/occurrence-ref";
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
 *
 * It takes a `ListedOccurrence` rather than a `TaskOccurrence` so that a stored
 * row and a projection of a repeat rule serialise through **one** function — the
 * client's `Task` type stays a single shape instead of a union, and the two
 * kinds are told apart by the `virtual` flag rather than by which procedure
 * returned them. `fromRow` is what lifts a plain row into that shape.
 */
function toPublicTask(task: feed.ListedOccurrence) {
  return {
    /**
     * A row's uuid, or the synthetic `series:<uuid>:<date>` reference for an
     * occurrence nobody has touched yet. See `src/lib/tasks/occurrence-ref.ts`.
     */
    id: task.id,
    seriesId: task.seriesId,
    /** True while this is a projection of a rule rather than a stored row. */
    virtual: task.virtual,
    title: task.title,
    description: task.description,
    occursOn: task.occursOn,
    deadlineAt: task.deadlineAt?.toISOString() ?? null,
    status: task.status,
    progressPct: task.progressPct,
    completedAt: task.completedAt?.toISOString() ?? null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    /**
     * A row's own tags, or — for a projection — its series' template tags. The
     * feed resolves both, so a component never has to ask which kind it has.
     */
    tags: task.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      color: tag.color,
    })),
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

/**
 * The search box and the three filter controls, as one optional value.
 *
 * On the read procedures rather than a procedure of their own: a filtered list
 * is the same list, and a second `task.search` would be a second read path with
 * its own merge, its own ordering and its own chance to disagree with this one.
 */
const filtersInput = z.object({ filters: taskFiltersInput.optional() });

export const taskRouter = router({
  /**
   * Every task the caller owns, newest day first — **including the occurrences
   * of their repeat rules**.
   *
   * The three reads below all go through `src/lib/tasks/feed.ts`, which merges
   * the materialised rows with the dates the caller's live series name for the
   * window on screen. Nothing is written during a read: an occurrence of a
   * series becomes a row the first time somebody touches it, and until then it
   * is projected from the rule.
   *
   * Materialised rows are unwindowed and projections are not — see the header of
   * `feed.ts` for why the record and the projection get different treatment.
   */
  list: activeProcedure
    // Optional, unlike its siblings: this procedure took no input at all before
    // recurrence gave it a window to derive, and `trpc.task.list.useQuery()`
    // with no argument is the call site in `task-list.tsx`. Optional keeps that
    // working while still letting a test pin the instant.
    .input(nowInput.extend(filtersInput.shape).optional())
    .query(async ({ ctx, input }) =>
      (
        await feed.listAllFeed(
          claimsFor(ctx),
          todayInZone(ctx.profile.timezone, input?.now ?? new Date()),
          ctx.profile.timezone,
          input?.filters,
        )
      ).map(toPublicTask),
    ),

  /**
   * The caller's tasks for one calendar day.
   *
   * `occursOn` is optional, and its absence means *today in the caller's own
   * timezone* — resolved here, on the server, from `ctx.profile.timezone`. The
   * client is never asked what day it is: that is criterion 19, and letting the
   * browser decide is precisely how SSR and hydration end up disagreeing. The
   * same is now true of the expansion window, which is derived from that day.
   */
  listForDay: activeProcedure
    .input(
      nowInput.extend({ occursOn: z.string().optional() }).extend(filtersInput.shape),
    )
    .query(async ({ ctx, input }) => {
      const day =
        input.occursOn ??
        todayInZone(ctx.profile.timezone, input.now ?? new Date());

      return (
        await feed.listDayFeed(
          claimsFor(ctx),
          day,
          ctx.profile.timezone,
          input.filters,
        )
      ).map(toPublicTask);
    }),

  /**
   * The derived overdue bucket — past its deadline and not finished.
   *
   * Not filtered by day, and not a stored flag: the predicate lives in
   * `occurrences.overdueCondition` and is evaluated on read, so marking a task
   * done or moving its deadline forward takes it out of this list on the very
   * next query with no job and no invalidation step (criteria 10 and 11).
   *
   * A projected occurrence of a series is judged by the TypeScript half of the
   * same definition, `isOverdue` — the two halves are asserted to agree in
   * `src/lib/tasks/overdue.test.ts`.
   */
  listOverdue: activeProcedure
    .input(nowInput.extend(filtersInput.shape))
    .query(async ({ ctx, input }) => {
      const now = input.now ?? new Date();

      return (
        await feed.listOverdueFeed(
          claimsFor(ctx),
          todayInZone(ctx.profile.timezone, now),
          now,
          ctx.profile.timezone,
          input.filters,
        )
      ).map(toPublicTask);
    }),

  /**
   * Create a one-off task.
   *
   * `seriesId` is not settable and is absent from the schema — a one-off is
   * defined by having none, and phase 3 will create series rows through their own
   * path rather than by letting a client assert membership.
   */
  create: activeProcedure
    .input(taskInput.and(nowInput).and(z.object({ tagIds: tagIdsField })))
    .mutation(async ({ ctx, input }) => {
      const { now, tagIds, ...task } = input;

      const created = await occurrences.create(claimsFor(ctx), {
        ...task,
        // Same rule as `listForDay`: the user's day, resolved server-side. A task
        // created at 23:30 in Manila belongs to that Manila day, not to whichever
        // day it happens to be in UTC.
        occursOn: task.occursOn ?? todayInZone(ctx.profile.timezone, now ?? new Date()),
      });

      // Written after the row exists, because `occurrence_tags` has a composite
      // foreign key onto `(id, user_id)` and there is nothing to point at until
      // then. A create with no tags issues no second statement at all.
      if (tagIds?.length) {
        await tagsRepo.setForOccurrence(claimsFor(ctx), created.id, tagIds);
      }

      return toPublicTask(feed.fromRow(created, []));
    }),

  /**
   * Patch a task. Absent fields are left alone; an explicit `null` clears one.
   *
   * ## This is also where an occurrence is materialised
   *
   * `id` accepts either a row's uuid or the synthetic `series:<uuid>:<date>`
   * reference a projected occurrence travels under. Touching a projection —
   * moving its slider, changing its status — is what turns it into a row, and
   * routing that through the *same* mutation is what keeps the client simple:
   * `use-task-actions.ts` has three mutations rather than four, a row and a card
   * share one in-flight state, and no component has to know that some
   * occurrences are not rows yet.
   *
   * The branch is here, on the server, where the series can be re-checked. A
   * reference naming a date the rule does not produce is `NOT_FOUND`, so a
   * client cannot plant a row on a day its series never names.
   *
   * A `null` from either path means nothing matched — the task belongs to
   * someone else, or never existed, or the series is deleted. All are
   * `NOT_FOUND` rather than `FORBIDDEN`: telling a caller that a task exists but
   * is not theirs would confirm the existence of another user's data, which is
   * exactly what this application promises not to do.
   */
  update: activeProcedure
    .input(taskUpdateInput.and(z.object({ tagIds: tagIdsField })))
    .mutation(async ({ ctx, input }) => {
      const { id, tagIds, ...patch } = input;

      const ref = parseOccurrenceRef(id);
      if (!ref) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      const updated =
        ref.kind === "virtual"
          ? await feed.materializeOccurrence(
              claimsFor(ctx),
              ref,
              // `occursOn` is deliberately not forwarded: the day of a recurring
              // occurrence belongs to the rule, and writing a row on some other
              // date is the thing the rule check above exists to prevent.
              {
                title: patch.title,
                description: patch.description,
                deadlineAt: patch.deadlineAt,
                status: patch.status,
                progressPct: patch.progressPct,
              },
              ctx.profile.timezone,
            )
          : await occurrences.update(claimsFor(ctx), ref.id, patch);

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Task not found" });
      }

      // Only when the caller actually sent a selection. `undefined` means "the
      // picker was not on screen" — a row control sending `{ id, status }` must
      // not be read as "remove every tag".
      if (tagIds !== undefined) {
        await tagsRepo.setForOccurrence(claimsFor(ctx), updated.id, tagIds);
      }

      const tags = await tagsRepo.tagsForOccurrences(claimsFor(ctx), [
        updated.id,
      ]);

      return toPublicTask(
        feed.fromRow(
          updated,
          tags.map((link) => link.tag),
        ),
      );
    }),

  /**
   * Delete a task. Hard delete — `deleted_at` belongs to series.
   *
   * `taskIdField` is a plain uuid, so a projected occurrence's reference fails
   * at the Zod boundary. That is deliberate rather than an oversight: deleting
   * an occurrence nobody has touched would be "skip this one occurrence", which
   * is out of v1 — and deleting a *materialised* one only makes the rule produce
   * it again on the next read, so the editor hides Delete for anything with a
   * `seriesId` and offers the repeat rule instead.
   */
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
