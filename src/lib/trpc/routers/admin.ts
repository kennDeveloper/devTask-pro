import { TRPCError } from "@trpc/server";
import { z } from "zod";

import {
  ADMIN_ACTIONS,
  ADMIN_ACTION_MESSAGES,
  ADMIN_ACTION_SPECS,
  canApply,
  resultOf,
  stampsApproval,
} from "@/lib/admin/transitions";
import * as profilesRepo from "@/lib/db/repos/profiles";
import type { AdminAccount } from "@/lib/db/repos/profiles";
import { sendRecoveryEmail, setAccountBanned } from "@/lib/supabase/admin";

import { adminProcedure, router } from "../server";

/**
 * The admin router — the tier that governs **access to the app, and nothing
 * else**.
 *
 * Four rules hold across every procedure here.
 *
 * 1. **`adminProcedure`, never anything lower.** It is composed on top of
 *    `activeProcedure`, so a *suspended* admin is refused on status before their
 *    role is even looked at — losing your account access has to cost you your
 *    admin access too, or suspension is not a revocation.
 *
 * 2. **Nothing in this file can reach task data.** It imports the `profiles`
 *    repo and the auth wrapper, and that is the whole list. There is no import
 *    of `repos/occurrences`, no import of `lib/tasks`, and `dbAdmin` is not
 *    imported here at all — the escalation lives one layer down, fenced and
 *    labelled. `toPublicAccount` cannot grow a task count because no query here
 *    fetches one. `src/lib/admin/isolation.test.ts` asserts that by reading this
 *    file off disk, and `tests/integration/rls-boundary.test.ts` asserts the
 *    live half.
 *
 * 3. **No procedure may target the caller's own account.** Stricter than "may
 *    not change their own role or status", and simpler to state and to test. It
 *    is the same rule `guard_profile_privileged_columns()` writes in SQL:
 *    *admins administer other people; nobody edits their own gate.* Hiding the
 *    buttons on your own row is presentation — this is the guarantee.
 *
 * 4. **The status column moves first, the auth ban second.** If the ban fails,
 *    the admin is left with a status change they can see and an error they can
 *    retry. The other order would leave an account banned out of the app with no
 *    record of why, which is the harder state to notice and to undo.
 */

/** The verified caller, in the shape the repo's audit fields want. */
function actorId(ctx: { user: { id: string } }): string {
  return ctx.user.id;
}

export const adminAccountInput = z.object({ userId: z.uuid() });

export const adminSetStatusInput = z.object({
  userId: z.uuid(),
  /**
   * Built from `ADMIN_ACTIONS` rather than written out, so an action added to
   * the transition table is accepted here without a second edit — and, more to
   * the point, one *removed* from it stops being accepted here immediately.
   */
  action: z.enum(ADMIN_ACTIONS),
});

/**
 * A JSON-safe view of an account.
 *
 * The tRPC link has **no transformer** (see `src/lib/trpc/client.tsx`), so a
 * `Date` crosses the wire as a string whatever the inferred type promises.
 *
 * Note what is absent and cannot be added by accident: there is no task field,
 * because `AdminAccount` has none — the repo's projection names eight columns of
 * `profiles` and `auth.users` and stops. `timezone` is dropped too: it is the
 * account holder's business and the admin has no use for it.
 */
function toPublicAccount(account: AdminAccount) {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    role: account.role,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    approvedAt: account.approvedAt?.toISOString() ?? null,
    lastSignInAt: account.lastSignInAt?.toISOString() ?? null,
  };
}

export type PublicAccount = ReturnType<typeof toPublicAccount>;

/**
 * Load the target, refusing the caller's own account first.
 *
 * The self check runs **before** the lookup so it costs nothing and so its
 * FORBIDDEN cannot be confused with a NOT_FOUND. Unlike the task router, a
 * missing account here is honestly `NOT_FOUND` rather than a disguised "not
 * yours": the admin is looking at a list of accounts they are entitled to see,
 * so there is no existence to conceal.
 */
async function loadTarget(
  ctx: { user: { id: string } },
  userId: string,
): Promise<AdminAccount> {
  if (userId === actorId(ctx)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: ADMIN_ACTION_MESSAGES.self,
    });
  }

  const account = await profilesRepo.findAccountAsAdmin(userId);
  if (!account) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: ADMIN_ACTION_MESSAGES.notFound,
    });
  }

  return account;
}

export const adminRouter = router({
  /**
   * Every account, for the admin list.
   *
   * Ordered by the repo — pending first, then newest first — because the order
   * is a property of the queue rather than of this projection, and the client
   * must not have to re-sort a list it did not decide the shape of.
   */
  list: adminProcedure.query(async () =>
    (await profilesRepo.listAccountsAsAdmin()).map(toPublicAccount),
  ),

  /**
   * Approve, reject, suspend or reinstate somebody else's account.
   *
   * One procedure rather than four, because the four are one state machine: the
   * guards below are identical for all of them, and four copies is four places
   * for the last-admin check to be forgotten in. Which action a row offers comes
   * from `actionsFor()`, and whether it is legal is re-decided here — the UI
   * hiding a button is a courtesy, this is the boundary.
   */
  setStatus: adminProcedure
    .input(adminSetStatusInput)
    .mutation(async ({ ctx, input }) => {
      const target = await loadTarget(ctx, input.userId);

      if (!canApply(input.action, target.status)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: ADMIN_ACTION_MESSAGES.illegalTransition,
        });
      }

      const outcome = await profilesRepo.setAccountStatusAsAdmin({
        actorId: actorId(ctx),
        targetId: input.userId,
        status: resultOf(input.action),
        stampApproval: stampsApproval(input.action),
      });

      if (!outcome.ok) {
        // The row was there a moment ago, so both of these are races rather
        // than user error. CONFLICT is the honest code for the second: the
        // request was well formed and would have been fine a second earlier.
        throw new TRPCError({
          code: outcome.reason === "not_found" ? "NOT_FOUND" : "CONFLICT",
          message:
            outcome.reason === "not_found"
              ? ADMIN_ACTION_MESSAGES.notFound
              : ADMIN_ACTION_MESSAGES.lastAdmin,
        });
      }

      // Second, and deliberately not in a transaction with the write above —
      // there is no transaction that spans Postgres and the auth service. See
      // the note at the top for why this order is the recoverable one.
      await setAccountBanned(input.userId, ADMIN_ACTION_SPECS[input.action].bans);

      return toPublicAccount(outcome.account);
    }),

  /**
   * Email somebody a password-recovery link.
   *
   * Changes no status and writes no row, which is why it is its own procedure
   * rather than a fifth action. The admin is told the address it went to and
   * never sees the link — see `src/lib/supabase/admin.ts` for why that
   * distinction is the difference between a helpdesk feature and an account
   * takeover.
   */
  sendPasswordReset: adminProcedure
    .input(adminAccountInput)
    .mutation(async ({ ctx, input }) => {
      const target = await loadTarget(ctx, input.userId);

      await sendRecoveryEmail(target.email);

      return { id: target.id, email: target.email };
    }),
});
