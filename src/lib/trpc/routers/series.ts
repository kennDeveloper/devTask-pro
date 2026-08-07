import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as seriesRepo from "@/lib/db/repos/series";
import * as tagsRepo from "@/lib/db/repos/tags";
import type { TagColor, TaskSeries } from "@/lib/db/schema";
import { groupTags, ruleFromSeries } from "@/lib/tasks/feed";
import {
  seriesInput,
  seriesUpdateInput,
  toRecurrenceRule,
} from "@/lib/tasks/series-validators";
import { tagIdsField } from "@/lib/tasks/tag-validators";
import { taskIdField } from "@/lib/tasks/validators";

import { activeProcedure, router } from "../server";

/**
 * The series router.
 *
 * The same three rules hold here as in `task.ts`, and each is load-bearing:
 *
 * 1. **`activeProcedure`, never `protectedProcedure`.** A `pending`, `rejected`
 *    or `suspended` account is authenticated but must not reach application
 *    data, and a repeat rule carries a title and notes — which is task data.
 *
 * 2. **No Drizzle, and no `dbAdmin`.** Every query goes through
 *    `src/lib/db/repos/series.ts`. This file cannot leak data it does not own
 *    because it has no way to ask for it (acceptance criterion 12).
 *
 * 3. **The caller's identity comes from `ctx.user`, never from the input.**
 *    There is no `userId` field in `series-validators.ts`; ownership is taken
 *    from the verified session and handed to the repo as claims.
 *
 * And one that is specific to series:
 *
 * 4. **No procedure here writes to `task_occurrence`.** Creating, editing and
 *    deleting a rule are all pure `task_series` operations — which is what makes
 *    acceptance criteria 15 and 17 fall out rather than needing to be
 *    implemented. See the header of `src/lib/tasks/feed.ts`.
 */

function claimsFor(ctx: { user: { id: string; email?: string } }) {
  return { sub: ctx.user.id, email: ctx.user.email };
}

/**
 * A JSON-safe view of a series row.
 *
 * The tRPC link has **no transformer** (see `src/lib/trpc/client.tsx`), so a
 * `Date` crosses the wire as a string whatever the inferred type promises.
 * Serialising here keeps that type honest, exactly as `toPublicTask` does.
 *
 * Two shaping decisions worth naming:
 *
 * - **The rule travels as one nested object**, matching `seriesInput`. The
 *   editor holds it as one value and `normaliseRule` takes all ten fields
 *   together; ten sibling keys would invite a caller to send half of them.
 * - **`rrule` is included but is not the rule.** It is the interchange format,
 *   useful for debugging and for the day the `rrule` package is adopted. The
 *   editor binds to the typed fields; nothing parses this string on the client.
 */
function toPublicSeries(
  series: TaskSeries,
  tags: ReadonlyArray<{ id: string; name: string; color: TagColor }> = [],
) {
  return {
    id: series.id,
    title: series.title,
    description: series.description,
    startsOn: series.startsOn,
    // Postgres reads a `time` column back as `HH:MM:SS`; the editor's control
    // speaks `HH:MM`. Trimmed once, here, rather than in each consumer.
    deadlineTime: series.deadlineTime ? series.deadlineTime.slice(0, 5) : null,
    rule: ruleFromSeries(series),
    rrule: series.rrule,
    /** The template tags, copied onto each occurrence as it materialises. */
    tags: tags.map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
  };
}

export type PublicSeries = ReturnType<typeof toPublicSeries>;

export const seriesRouter = router({
  /** Every live series the caller owns. Deleted ones are never listed. */
  list: activeProcedure.query(async ({ ctx }) => {
    const live = await seriesRepo.listActive(claimsFor(ctx));

    // One query for every series on the page, not one per series.
    const links = await tagsRepo.tagsForSeries(
      claimsFor(ctx),
      live.map((series) => series.id),
    );
    const bySeries = groupTags(links);

    return live.map((series) =>
      toPublicSeries(series, bySeries.get(series.id) ?? []),
    );
  }),

  /**
   * One series, for the editor.
   *
   * A series that is not the caller's is `NOT_FOUND` rather than `FORBIDDEN`,
   * for the reason `task.update` gives: telling a caller that a series exists
   * but is not theirs confirms the existence of another user's data, which is
   * exactly what this application promises not to do.
   */
  get: activeProcedure
    .input(z.object({ id: taskIdField }))
    .query(async ({ ctx, input }) => {
      const found = await seriesRepo.findOwn(claimsFor(ctx), input.id);
      if (!found) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Series not found" });
      }

      const links = await tagsRepo.tagsForSeries(claimsFor(ctx), [found.id]);
      return toPublicSeries(
        found,
        links.map((link) => link.tag),
      );
    }),

  /**
   * Create a repeat rule.
   *
   * Writes no occurrences. Every date the rule names is a projection until
   * somebody touches it — that is the whole of "materialise on touch, never on
   * read", and it is why creating a daily series that runs for a year costs one
   * row rather than 365.
   */
  create: activeProcedure
    .input(seriesInput.and(z.object({ tagIds: tagIdsField })))
    .mutation(async ({ ctx, input }) => {
      const created = await seriesRepo.create(claimsFor(ctx), {
        title: input.title,
        description: input.description ?? null,
        startsOn: input.startsOn,
        deadlineTime: input.deadlineTime ?? null,
        rule: toRecurrenceRule(input.rule),
      });

      // Template tags. Written to `series_tags` only — occurrences that already
      // exist keep whatever they materialised with, which is the same rule every
      // other series field follows.
      if (input.tagIds?.length) {
        await tagsRepo.setForSeries(claimsFor(ctx), created.id, input.tagIds);
      }

      const links = await tagsRepo.tagsForSeries(claimsFor(ctx), [created.id]);
      return toPublicSeries(
        created,
        links.map((link) => link.tag),
      );
    }),

  /**
   * Replace a repeat rule — **acceptance criterion 15**.
   *
   * A replacement rather than a patch, because a rule is one value (see
   * `seriesUpdateInput`). Nothing here touches `task_occurrence`: untouched
   * occurrences were never rows and follow the new rule on the next read, while
   * occurrences carrying a status or a progress figure are rows and keep both —
   * including on a date the new rule no longer names.
   */
  update: activeProcedure
    .input(seriesUpdateInput.and(z.object({ tagIds: tagIdsField })))
    .mutation(async ({ ctx, input }) => {
      const updated = await seriesRepo.update(claimsFor(ctx), input.id, {
        title: input.title,
        description: input.description ?? null,
        startsOn: input.startsOn,
        deadlineTime: input.deadlineTime ?? null,
        rule: toRecurrenceRule(input.rule),
      });

      if (!updated) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Series not found" });
      }

      if (input.tagIds !== undefined) {
        await tagsRepo.setForSeries(claimsFor(ctx), updated.id, input.tagIds);
      }

      const links = await tagsRepo.tagsForSeries(claimsFor(ctx), [updated.id]);
      return toPublicSeries(
        updated,
        links.map((link) => link.tag),
      );
    }),

  /**
   * Delete a repeat rule — **acceptance criterion 17**.
   *
   * A soft delete, and again nothing touches `task_occurrence`. The series stops
   * being expanded, so its untouched future occurrences disappear; its
   * materialised rows still resolve their `series_id` and survive exactly as
   * they were. A hard delete would cascade them away through 0005's foreign key,
   * taking the completed history the criterion says must remain.
   */
  remove: activeProcedure
    .input(z.object({ id: taskIdField }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await seriesRepo.softDelete(claimsFor(ctx), input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Series not found" });
      }

      return { id: input.id };
    }),
});
