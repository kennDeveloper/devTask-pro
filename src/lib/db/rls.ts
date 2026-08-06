import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { dbAdmin } from "./client";
import type * as schema from "./schema";

/**
 * The RLS-scoped query path. This is how user-facing code touches the database.
 *
 * `dbAdmin` connects as the database owner and bypasses Row Level Security. That is
 * correct for the reminder job and admin account operations, and wrong for anything
 * a person triggers about their own data. `withUser()` borrows that connection but
 * demotes it, for the duration of one transaction, to the `authenticated` role
 * carrying a specific user's JWT claims — at which point Postgres enforces the
 * policies in `supabase/migrations/0003_rls_policies.sql` on every statement.
 *
 * The effect: a forgotten `.where(eq(table.userId, ctx.user.id))` is no longer a data
 * leak. The database returns the caller's rows and nothing else, because the caller
 * is not permitted to see anything else.
 */

/**
 * The subset of Supabase JWT claims the database actually reads.
 *
 * `sub` is the only load-bearing one: Supabase defines `auth.uid()` as
 * `(current_setting('request.jwt.claims')::jsonb ->> 'sub')::uuid`, so `sub` is what
 * every `using (id = (select auth.uid()))` policy resolves against. `role` and `email`
 * are set for parity with a real PostgREST request, so anything reading
 * `auth.jwt()` behaves the same under Drizzle as it would through the Data API.
 */
export interface UserClaims {
  sub: string;
  email?: string;
  role?: string;
}

/** A Drizzle transaction handle, derived from the client so the two cannot drift. */
export type ScopedTx = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

/**
 * Run `fn` against the database as `userId`, with RLS enforced.
 *
 * ```ts
 * const rows = await withUser({ sub: user.id, email: user.email }, (tx) =>
 *   tx.select().from(profiles),           // returns ONLY this user's profile
 * );
 * ```
 *
 * Three details matter and are easy to get wrong:
 *
 * 1. **Claims are set before the role switch.** `set_config` on `request.jwt.claims`
 *    is issued while still connected as the owner. Reversing the order can fail
 *    depending on the demoted role's permissions.
 *
 * 2. **Both settings are `LOCAL`** — `set_config(..., true)` and `set local role`.
 *    They are scoped to this transaction and unwind on COMMIT *or* ROLLBACK. That is
 *    what makes this safe over a connection pool: the next borrower of the same
 *    physical connection cannot inherit a previous caller's identity. There is a test
 *    for exactly this in `tests/integration/rls-boundary.test.ts`.
 *
 * 3. **`fn` receives `tx`, and must use it.** Reaching for the imported `dbAdmin`
 *    inside the callback issues the query on a different, unscoped connection and
 *    silently escapes the boundary. The callback signature is the only reason this
 *    is hard to do by accident — there is no ambient scoped `db` to grab.
 */
export async function withUser<T>(
  claims: UserClaims,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T> {
  const payload = JSON.stringify({ role: "authenticated", ...claims });

  return dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${payload}, true)`,
    );
    await tx.execute(sql`set local role authenticated`);
    return fn(tx);
  });
}

/**
 * Convenience wrapper for the common case of a Supabase Auth user object.
 * Returns `null` without touching the database when there is no signed-in user, so
 * callers can treat "anonymous" and "no rows" the same way.
 */
export async function withOptionalUser<T>(
  user: { id: string; email?: string } | null,
  fn: (tx: ScopedTx) => Promise<T>,
): Promise<T | null> {
  if (!user) return null;
  return withUser({ sub: user.id, email: user.email }, fn);
}
