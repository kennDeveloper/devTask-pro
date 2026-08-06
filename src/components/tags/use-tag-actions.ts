"use client";

import { trpc } from "@/lib/trpc/client";

/**
 * The three tag mutations, with one invalidation policy between them.
 *
 * ## Why every success invalidates `task` as well as `tag`
 *
 * A tag is not only a row in the manager — it is a chip on every task carrying
 * it, and an option in the filter bar. Renaming one changes what a dozen rows
 * say; deleting one removes chips and, if that tag was being filtered on,
 * changes which rows are on screen at all. Invalidating `tag` alone would leave
 * the manager correct and the list stale, which is the half the user is usually
 * looking at.
 *
 * `series` is deliberately **not** invalidated: a series' template tags are read
 * through `series.get`, which is only mounted while the rule editor is open, and
 * refetching a series the user is mid-edit on would fight their typing. The
 * editor reads tags when it opens; that is soon enough.
 */
export function useTagActions() {
  const utils = trpc.useUtils();

  const invalidate = () => {
    void utils.tag.invalidate();
    void utils.task.invalidate();
  };

  return {
    create: trpc.tag.create.useMutation({ onSuccess: invalidate }),
    update: trpc.tag.update.useMutation({ onSuccess: invalidate }),
    remove: trpc.tag.remove.useMutation({ onSuccess: invalidate }),
  };
}
