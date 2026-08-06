import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as tagsRepo from "@/lib/db/repos/tags";
import type { Tag } from "@/lib/db/schema";
import {
  tagIdField,
  tagInput,
  tagUpdateInput,
  TAG_MESSAGES,
} from "@/lib/tasks/tag-validators";

import { activeProcedure, router } from "../server";

/**
 * The tag router.
 *
 * The same rules as `task.ts` and `series.ts`, and for the same reasons:
 * `activeProcedure` on every procedure, no Drizzle and no `dbAdmin`, and the
 * caller's identity taken from `ctx.user` rather than from the input. A tag is a
 * label somebody chose and applied to their private work — the set of them
 * describes what a person does all day — so it gets the same boundary as the
 * tasks it labels.
 */

function claimsFor(ctx: { user: { id: string; email?: string } }) {
  return { sub: ctx.user.id, email: ctx.user.email };
}

/**
 * A JSON-safe view of a tag. The link has no transformer, so `Date`s go out as
 * ISO strings and the inferred client type stays honest.
 *
 * `userId` is dropped: the caller is the owner by construction.
 */
function toPublicTag(tag: Tag) {
  return {
    id: tag.id,
    name: tag.name,
    color: tag.color,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

export type PublicTag = ReturnType<typeof toPublicTag>;

/**
 * Postgres's unique-violation SQLSTATE.
 *
 * Drizzle wraps driver errors, so the code is on `.cause` rather than on the
 * thrown error — the same detail `rls-boundary.test.ts` calls out for messages.
 * Matching on the code rather than the message text is what keeps this working
 * if the index is ever renamed.
 */
function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause;
  return cause?.code === "23505";
}

export const tagRouter = router({
  /** Every tag the caller owns, alphabetically. */
  list: activeProcedure.query(async ({ ctx }) =>
    (await tagsRepo.list(claimsFor(ctx))).map(toPublicTag),
  ),

  /**
   * Create a tag.
   *
   * A name colliding case-insensitively with an existing one is a `CONFLICT`
   * carrying a sentence, not a 500 carrying a Postgres index name. The check is
   * the database's — `tags_user_name_uniq` in 0006 — rather than a read-then-write
   * here, because two requests can both pass a read and only one can win the
   * insert. The manager also compares locally to warn before the round trip;
   * both use `normaliseTagName`, so they cannot disagree about what "the same
   * name" means.
   */
  create: activeProcedure
    .input(tagInput)
    .mutation(async ({ ctx, input }) => {
      try {
        const created = await tagsRepo.create(claimsFor(ctx), input);
        return toPublicTag(created);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: TAG_MESSAGES.duplicate,
          });
        }
        throw error;
      }
    }),

  /**
   * Rename or recolour a tag.
   *
   * Writes to `tags` and nowhere else — a tag is referenced by id, so a rename
   * is reflected everywhere it appears without touching a single task. That is
   * acceptance criterion 4, and it is a property of the schema rather than of
   * this procedure.
   */
  update: activeProcedure
    .input(tagUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const { id, ...patch } = input;

      try {
        const updated = await tagsRepo.update(claimsFor(ctx), id, patch);
        if (!updated) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
        }
        return toPublicTag(updated);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: TAG_MESSAGES.duplicate,
          });
        }
        throw error;
      }
    }),

  /**
   * Delete a tag.
   *
   * A hard delete. The `on delete cascade` on both join tables removes the links
   * and stops there, so **no task is deleted** — acceptance criterion 3, again
   * enforced by the schema rather than by this code remembering to be careful.
   */
  remove: activeProcedure
    .input(z.object({ id: tagIdField }))
    .mutation(async ({ ctx, input }) => {
      const deleted = await tagsRepo.remove(claimsFor(ctx), input.id);
      if (!deleted) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tag not found" });
      }

      return { id: input.id };
    }),
});
