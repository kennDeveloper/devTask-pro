import { and, desc, eq, sql } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import { withUser, type UserClaims } from "@/lib/db/rls";
import {
  authUsers,
  profiles,
  type Profile,
  type ProfileRole,
  type ProfileStatus,
} from "@/lib/db/schema";

/**
 * The `profiles` repo.
 *
 * `AGENTS.md` has always said one repo module per table, with routes and lib code
 * calling the repo rather than Drizzle. Phase 1 shipped without the directory, so
 * `buildContext` and `profile.update` each grew their own query. Phase 2 created
 * `repos/occurrences.ts` for the first real data table, and leaving `profiles` as
 * the one exception would have made the convention a thing you have to already
 * know rather than a thing the code shows you.
 *
 * The two functions at the top go through `withUser()`, so `profiles_select_own`
 * and `profiles_update_own` (0003) apply. **Phase 5 added a second section at the
 * bottom that does not** — see the banner there. The split the phase-1 comment
 * asked for is kept as a naming rule rather than a file boundary: every escalated
 * function is suffixed `AsAdmin`, so "read my profile" and "change somebody
 * else's status" can never be reached for by accident, while `profiles` still has
 * exactly one repo module as `AGENTS.md` requires.
 */

/**
 * The caller's own profile row, or `null`.
 *
 * `null` is not an error. It happens when the row genuinely does not exist yet —
 * the `handle_new_user` trigger runs on `auth.users` insert, so there is a narrow
 * window during signup — and callers are expected to treat it as "not active",
 * failing closed. See `buildContext`.
 *
 * The `where` is belt-and-braces: `profiles_select_own` already reduces this to
 * the caller's row, so the clause cannot change the result. It is written anyway
 * so the statement is correct on its own terms rather than correct only because a
 * policy happens to be in place.
 */
export async function findOwn(claims: UserClaims): Promise<Profile | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.id, claims.sub))
      .limit(1);

    return rows[0] ?? null;
  });
}

/**
 * Fields the account holder may change about themselves.
 *
 * Note what is absent, and that it is absent in three places at once: `role` and
 * `status` are missing from this type, from `profileUpdateInput`'s Zod schema, and
 * — the one that actually stops it — from what
 * `guard_profile_privileged_columns()` in 0003 will allow. The type and the schema
 * are courtesy; the trigger is the boundary, and it holds even if a future
 * resolver passes an unvalidated object straight to `.set()`.
 */
export interface UpdateOwnProfilePatch {
  displayName?: string;
  timezone?: string;
}

/**
 * Update the caller's own profile. Returns the updated row, or `null` if RLS
 * matched nothing.
 *
 * `undefined` fields are omitted rather than written, so a patch naming only a
 * timezone cannot blank a display name. `updated_at` is left alone — the
 * `profiles_touch_updated_at` trigger in 0002 maintains it.
 */
export async function updateOwn(
  claims: UserClaims,
  patch: UpdateOwnProfilePatch,
): Promise<Profile | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .update(profiles)
      .set({
        ...(patch.displayName !== undefined && {
          displayName: patch.displayName,
        }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
      })
      .where(eq(profiles.id, claims.sub))
      .returning();

    return rows[0] ?? null;
  });
}

// ===========================================================================
//
//   THE ADMIN SECTION — EVERYTHING BELOW THIS LINE BYPASSES ROW LEVEL SECURITY
//
// ===========================================================================
//
// `dbAdmin` connects as the database owner. Not one policy in
// `supabase/migrations/0003_rls_policies.sql` applies to anything below, and no
// mistake made here will be caught by the database. This is the carve-out
// `src/lib/db/client.ts` names — "admin account operations … restricted to
// `profiles`" — and phase 5 is one of the three callers it sanctions.
//
// THE RULE, and it is the whole reason this section is fenced off and labelled:
//
//   **Every statement below may name `profiles` and `auth.users`. Nothing else.**
//
// A "just show open task counts" column on the admin list would be one join away
// from here and would quietly undo the guarantee criterion 6 exists to give — an
// admin's own session reading `task_occurrence` gets zero rows, and it has to
// stay that way through every path, not just the scoped one. If you want that
// column, change the decision in `docs/gsd/devtask-pro-v1.md` first. There is a
// source-level assertion in `src/lib/admin/isolation.test.ts` that fails if this
// file ever mentions a task table, and a live one in
// `tests/integration/rls-boundary.test.ts`.
//
// The escalation guard in 0003 lets these writes through because a direct
// connection never set `request.jwt.claims`, so `auth.uid()` is null and
// `auth.uid() = old.id` is null rather than true. That is deliberate, and it is
// also what stops an admin from moving their *own* role or status here: they
// would have to do it through their session, where the guard does fire. The
// router refuses a self-targeted action for the same reason, one layer earlier.

/** Enough of an account for the admin list. Deliberately no task field exists to omit. */
export interface AdminAccount {
  id: string;
  email: string;
  displayName: string | null;
  role: ProfileRole;
  status: ProfileStatus;
  approvedAt: Date | null;
  createdAt: Date;
  /** From `auth.users`; null until the account has signed in once. */
  lastSignInAt: Date | null;
}

/**
 * Pagination is out of scope for phase 5, but an unbounded `select` across a
 * table that only grows is not a thing to leave for a later reader to discover.
 * The day 500 accounts is not enough is the day this earns a real design.
 */
export const ACCOUNT_LIST_LIMIT = 500;

/**
 * The exact columns the admin tier may see, written once.
 *
 * A projection rather than `select()` because `select()` returns whatever the
 * table happens to hold — so a column added to `profiles` in a later phase would
 * arrive on the admin's screen without anybody deciding it should.
 */
const ACCOUNT_COLUMNS = {
  id: profiles.id,
  email: profiles.email,
  displayName: profiles.displayName,
  role: profiles.role,
  status: profiles.status,
  approvedAt: profiles.approvedAt,
  createdAt: profiles.createdAt,
  lastSignInAt: authUsers.lastSignInAt,
} as const;

/**
 * Every account, for the admin list. **Bypasses RLS.**
 *
 * Ordered pending-first, then newest-first. The admin's actual job is the queue
 * of people waiting on a decision, and burying those under six months of settled
 * accounts would make the one screen this tier has answer the wrong question.
 *
 * `leftJoin` rather than `innerJoin`: a profile whose auth user has been deleted
 * out from under it should still be visible and actionable, not silently absent.
 * The FK cascade makes that near-impossible, and "near" is doing work there.
 */
export async function listAccountsAsAdmin(): Promise<AdminAccount[]> {
  return dbAdmin
    .select(ACCOUNT_COLUMNS)
    .from(profiles)
    .leftJoin(authUsers, eq(authUsers.id, profiles.id))
    .orderBy(
      sql`case when ${profiles.status} = 'pending' then 0 else 1 end`,
      desc(profiles.createdAt),
    )
    .limit(ACCOUNT_LIST_LIMIT);
}

/** One account by id, same projection. **Bypasses RLS.** */
export async function findAccountAsAdmin(
  id: string,
): Promise<AdminAccount | null> {
  const rows = await dbAdmin
    .select(ACCOUNT_COLUMNS)
    .from(profiles)
    .leftJoin(authUsers, eq(authUsers.id, profiles.id))
    .where(eq(profiles.id, id))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The outcome of a status change, as a value rather than an exception.
 *
 * "This account is gone" and "this is the last administrator" are both ordinary
 * answers the admin needs to read, not faults. Returning them lets the router
 * map each to its own tRPC code at the boundary, where the codes belong, instead
 * of the repo throwing something the router has to pattern-match on a message.
 */
export type SetAccountStatusOutcome =
  | { ok: true; account: AdminAccount }
  | { ok: false; reason: "not_found" | "last_admin" };

export interface SetAccountStatusInput {
  /** The admin performing the change; recorded as `approved_by` on a first approval. */
  actorId: string;
  targetId: string;
  status: ProfileStatus;
  /** True for the actions that end with the account active. See `stampsApproval`. */
  stampApproval: boolean;
}

/**
 * Move somebody else's account status. **Bypasses RLS.**
 *
 * ## The last-administrator guard, and why it is inside the transaction
 *
 * Criterion 10 says an admin cannot suspend the last remaining active admin.
 * Written the obvious way — count, then update — that guard is a lie under
 * concurrency: two admins revoking each other at the same moment both read a
 * count of two, both decide they are fine, and the app is left with none.
 *
 * So the active-admin set is locked with `for update` **before** anything is
 * read or written. Under READ COMMITTED, Postgres re-evaluates the WHERE clause
 * after acquiring each row lock, so the second transaction to arrive wakes up,
 * finds the row it was counting on is no longer `active`, and correctly refuses.
 * The lock is taken first so both transactions contend on the same rows in the
 * same order and cannot deadlock against each other.
 *
 * ## `approved_at` is stamped once and never rewritten
 *
 * Approving a previously-rejected account is still the moment they were let in,
 * so it stamps. Reinstating somebody who has been in since March must not move
 * their join date to today, so a non-null `approved_at` is left alone.
 *
 * `updated_at` is not set here — `profiles_touch_updated_at` (0002) maintains it,
 * and application code that writes it is fighting the trigger.
 */
export async function setAccountStatusAsAdmin({
  actorId,
  targetId,
  status,
  stampApproval,
}: SetAccountStatusInput): Promise<SetAccountStatusOutcome> {
  return dbAdmin.transaction(async (tx) => {
    const activeAdmins = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(and(eq(profiles.role, "admin"), eq(profiles.status, "active")))
      .for("update");

    const [target] = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.id, targetId))
      .limit(1);

    if (!target) return { ok: false, reason: "not_found" };

    // Only a revocation aimed at an administrator can empty the set. Approving
    // somebody, or suspending an ordinary member, never can.
    if (status !== "active" && target.role === "admin") {
      const remaining = activeAdmins.filter(
        (admin) => admin.id !== targetId,
      ).length;
      if (remaining < 1) return { ok: false, reason: "last_admin" };
    }

    await tx
      .update(profiles)
      .set({
        status,
        ...(stampApproval && target.approvedAt === null
          ? { approvedAt: new Date(), approvedBy: actorId }
          : {}),
      })
      .where(eq(profiles.id, targetId));

    // Re-read through the same projection so the caller gets exactly what the
    // list gives it, `last_sign_in_at` included. `returning()` on the update
    // above would hand back a bare `profiles` row and a second shape to keep
    // in step.
    const [account] = await tx
      .select(ACCOUNT_COLUMNS)
      .from(profiles)
      .leftJoin(authUsers, eq(authUsers.id, profiles.id))
      .where(eq(profiles.id, targetId))
      .limit(1);

    return { ok: true, account };
  });
}

/**
 * How many administrators can currently sign in. **Bypasses RLS.**
 *
 * Not used by the guard above — that one has to count inside its own
 * transaction to be worth anything. This is for anything that merely wants to
 * *display* the number, and for the integration test to assert against.
 */
export async function countActiveAdminsAsAdmin(): Promise<number> {
  const rows = await dbAdmin
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.role, "admin"), eq(profiles.status, "active")));

  return rows.length;
}
