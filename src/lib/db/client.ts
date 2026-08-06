import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

/**
 * THE PRIVILEGED CONNECTION. Read this before using it.
 *
 * `dbAdmin` connects as the database owner, which means it **bypasses Row Level
 * Security entirely**. Every policy in `supabase/migrations/0003_rls_policies.sql`
 * is invisible to it. It can read and write any row belonging to any user.
 *
 * It is named `dbAdmin` rather than `db` on purpose: there is no innocuous-looking
 * import that hands you an unscoped connection by accident. Reaching for this name
 * should read, at the call site, as a deliberate escalation.
 *
 * The ONLY legitimate callers are:
 *
 *   1. The reminder job — it must read deadlines across all users to know who to
 *      email. Its output is an email to the task's own owner; no human ever sees
 *      another person's data.
 *   2. Admin account operations — approve / reject / suspend / trigger a password
 *      reset. These read and write `profiles` rows belonging to other people, and
 *      are restricted to `profiles`. They must never touch a task table.
 *   3. Migrations, seeds, and `scripts/create-admin.ts`.
 *
 * Anything user-facing goes through `withUser()` in `./rls.ts`, which scopes the
 * connection to one person's JWT so Postgres enforces ownership for you.
 *
 * The rule in one line: **no human-facing route may read data it does not own.**
 * Adding a "just show open task counts" widget to the admin UI would require this
 * connection, and would quietly undo the guarantee the RLS policies exist to give.
 * If you are about to do that, change the decision in `docs/gsd/devtask-pro-v1.md`
 * first — do not route around it here.
 *
 * Lazily initialised behind a Proxy so `next build`, which imports the route graph
 * for static analysis, does not need `DATABASE_URL` to be present.
 */
const globalForDb = globalThis as unknown as {
  __devtaskPgClient?: ReturnType<typeof postgres>;
  __devtaskDb?: PostgresJsDatabase<typeof schema>;
};

function init(): PostgresJsDatabase<typeof schema> {
  if (globalForDb.__devtaskDb) return globalForDb.__devtaskDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // `prepare: false` is required for compatibility with connection poolers
  // (Supabase's Supavisor in transaction mode cannot replay prepared statements).
  const client =
    globalForDb.__devtaskPgClient ??
    postgres(connectionString, { prepare: false });
  const instance = drizzle(client, { schema });

  globalForDb.__devtaskPgClient = client;
  globalForDb.__devtaskDb = instance;
  return instance;
}

export const dbAdmin = new Proxy({} as PostgresJsDatabase<typeof schema>, {
  get(_target, prop, receiver) {
    return Reflect.get(init(), prop, receiver) as unknown;
  },
});

export { schema };
