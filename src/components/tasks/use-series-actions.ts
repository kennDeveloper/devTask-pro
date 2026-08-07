"use client";

import { trpc } from "@/lib/trpc/client";

/**
 * The three series mutations, with one invalidation policy between them.
 *
 * ## Why every success invalidates `task` as well as `series`
 *
 * A repeat rule is not visible anywhere on its own — what a user sees is the
 * occurrences it produces, which arrive through the `task` router. Creating a
 * rule adds rows to every list in its window; editing one moves the untouched
 * occurrences; deleting one removes them. Invalidating only `series` would
 * update a list nobody is looking at and leave the one they are.
 *
 * The converse is not true, which is why `use-task-actions.ts` does not
 * invalidate `series`: touching an occurrence writes a `task_occurrence` row and
 * changes nothing about the rule.
 */
export function useSeriesActions() {
  const utils = trpc.useUtils();

  const invalidate = () => {
    void utils.series.invalidate();
    void utils.task.invalidate();
  };

  /**
   * Deleting invalidates the **list**, but not `series.get`.
   *
   * The editor is still mounted when the mutation resolves — the hook-level
   * `onSuccess` runs before the per-call one that closes it — so a blanket
   * `series.invalidate()` refetches `series.get` for the id that has just been
   * deleted, and the server answers the only way it can: `NOT_FOUND`. Harmless
   * to the user, whose dialog closes a moment later, but it puts a spurious
   * error in the log on every single delete, which is exactly the kind of noise
   * that trains people to ignore the real ones.
   */
  const invalidateAfterDelete = () => {
    void utils.series.list.invalidate();
    void utils.task.invalidate();
  };

  return {
    create: trpc.series.create.useMutation({ onSuccess: invalidate }),
    update: trpc.series.update.useMutation({ onSuccess: invalidate }),
    remove: trpc.series.remove.useMutation({
      onSuccess: invalidateAfterDelete,
    }),
  };
}
