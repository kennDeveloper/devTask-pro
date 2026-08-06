"use client";

import { trpc } from "@/lib/trpc/client";

/**
 * The two admin mutations, with one invalidation policy between them.
 *
 * ## Why a success invalidates the whole `admin` router
 *
 * An account does not belong to one place in the list: approving somebody moves
 * them out of the pending block that the repo sorts first, so the row they were
 * on is now a different row. Patching the cache in place would need the client
 * to re-derive that ordering — the same duplicated rule
 * `src/lib/admin/transitions.ts` exists to prevent. Refetching asks the server
 * the question it already knows how to answer.
 *
 * ## Why this is a hook each row calls, not one instance passed down
 *
 * `Button`'s `loading` prop needs *that* row's in-flight state. One shared
 * mutation would light every row's spinner at once and the row nobody touched
 * would look like it was saving. One `useMutation` per row is the shape
 * react-query is built for — the cache is global, the state is local.
 *
 * Within a row, `setStatus.variables?.action` is what tells the four buttons
 * apart, which is why one mutation with an action enum costs nothing here.
 */
export function useAccountActions() {
  const utils = trpc.useUtils();

  const invalidate = () => {
    void utils.admin.invalidate();
  };

  return {
    setStatus: trpc.admin.setStatus.useMutation({ onSuccess: invalidate }),
    /**
     * No invalidation: sending a recovery email changes no row, so refetching
     * would be a network round trip that provably cannot alter the screen.
     */
    sendPasswordReset: trpc.admin.sendPasswordReset.useMutation(),
  };
}

export type AccountActions = ReturnType<typeof useAccountActions>;
