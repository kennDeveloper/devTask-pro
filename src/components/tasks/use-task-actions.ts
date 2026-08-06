"use client";

import { trpc } from "@/lib/trpc/client";

/**
 * The three task mutations, with one invalidation policy between them.
 *
 * ## Why every success invalidates the whole `task` router
 *
 * A task does not belong to one list. Marking one `done` removes it from
 * `listOverdue` (the predicate is `deadline_at < now() and status <> 'done'`);
 * moving its deadline forward does the same; changing `occursOn` moves it
 * between days in `listForDay`; and all three still appear in `list`. Working
 * out which queries a given patch invalidates means re-deriving those predicates
 * on the client, which is precisely the duplicated rule `src/lib/tasks/overdue.ts`
 * exists to prevent. Invalidating `task` wholesale asks the server the question
 * it already knows how to answer. The cost is one refetch of a list the user is
 * looking at; the alternative is a row that lingers in Overdue after being
 * completed and no obvious reason why.
 *
 * ## Why this is a hook each row calls, not one instance passed down
 *
 * `Button`'s `loading` prop needs *that* row's in-flight state. A single shared
 * mutation would put every row's spinner on at once, and the row you did not
 * touch would look like it was saving. One `useMutation` per row is what
 * react-query is shaped for — the mutation cache is global, the state is local.
 */
export function useTaskActions() {
  const utils = trpc.useUtils();

  const invalidate = () => {
    void utils.task.invalidate();
  };

  return {
    create: trpc.task.create.useMutation({ onSuccess: invalidate }),
    update: trpc.task.update.useMutation({ onSuccess: invalidate }),
    remove: trpc.task.remove.useMutation({ onSuccess: invalidate }),
  };
}
