import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import { withUser } from "@/lib/db/rls";
import { profiles, taskOccurrence } from "@/lib/db/schema";

/**
 * THE RLS BOUNDARY PROOF.
 *
 * devtask-pro promises that an admin never sees another person's task data. That
 * promise is only worth anything if it is enforced by the database rather than by
 * remembering to write a `.where()` clause. This spec is the evidence.
 *
 * Phase 1 proved the mechanism against `profiles`, because no task table existed
 * yet, and left criterion 6 of `docs/gsd/devtask-pro-v1.md` explicitly open.
 * **Phase 2 closes it**: the `task_occurrence` block at the bottom of this file is
 * the real thing — an admin's session reading actual task data and getting
 * nothing. The `profiles` blocks are kept rather than replaced, because they
 * cover a rule tasks do not have (the self-promotion guard).
 *
 * Requires the local stack: `pnpm db:start`. Run with `pnpm test:integration`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const stamp = Date.now();
const EMAIL_A = `rls-a-${stamp}@devtask.local`;
const EMAIL_B = `rls-b-${stamp}@devtask.local`;
const EMAIL_ADMIN = `rls-admin-${stamp}@devtask.local`;

let admin: SupabaseClient;
let userA: string;
let userB: string;
let adminUser: string;

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "correct-horse-battery-staple",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

beforeAll(async () => {
  admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  userA = await createUser(EMAIL_A);
  userB = await createUser(EMAIL_B);
  adminUser = await createUser(EMAIL_ADMIN);

  // Promote the third user through the privileged path — which is the only path
  // that can do it, per the escalation guard in 0003.
  await dbAdmin
    .update(profiles)
    .set({ role: "admin", status: "active" })
    .where(eq(profiles.id, adminUser));
});

afterAll(async () => {
  for (const id of [userA, userB, adminUser]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

describe("withUser() scopes queries to one identity", () => {
  it("(a) returns exactly the caller's own row", async () => {
    const rows = await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx.select().from(profiles),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(userA);
    expect(rows[0].email).toBe(EMAIL_A);
  });

  it("(b) cannot see another user's row, even when asked for it by id", async () => {
    const rows = await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.select().from(profiles).where(eq(profiles.id, userA)),
    );

    // Not "throws" — RLS filters silently. Asking for someone else's row by
    // primary key returns nothing at all.
    expect(rows).toHaveLength(0);
  });

  it("(c) an ADMIN cannot see another user's row either — role does not defeat RLS", async () => {
    const rows = await withUser({ sub: adminUser, email: EMAIL_ADMIN }, (tx) =>
      tx.select().from(profiles),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(adminUser);

    const targeted = await withUser({ sub: adminUser }, (tx) =>
      tx.select().from(profiles).where(eq(profiles.id, userA)),
    );
    expect(targeted).toHaveLength(0);
  });

  it("(d) dbAdmin still sees everything — the escalation path works", async () => {
    const rows = await dbAdmin.select().from(profiles);
    const ids = rows.map((r) => r.id);

    expect(ids).toEqual(expect.arrayContaining([userA, userB, adminUser]));
  });
});

describe("the scope unwinds — no leakage across pooled connections", () => {
  it("(e) a throwing withUser() leaves the connection unscoped for the next borrower", async () => {
    await expect(
      withUser({ sub: userA }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Same physical connection, borrowed again. If `set local role` had leaked,
    // this would come back as `authenticated` and see one row instead of all.
    const who = await dbAdmin.execute<{ current_user: string }>(
      sql`select current_user`,
    );
    expect(who[0].current_user).toBe("postgres");

    const claims = await dbAdmin.execute<{ claims: string | null }>(
      sql`select current_setting('request.jwt.claims', true) as claims`,
    );
    expect(claims[0].claims ?? "").toBe("");

    const rows = await dbAdmin.select().from(profiles);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it("(e2) a successful withUser() also unwinds", async () => {
    await withUser({ sub: userA }, (tx) => tx.select().from(profiles));

    const who = await dbAdmin.execute<{ current_user: string }>(
      sql`select current_user`,
    );
    expect(who[0].current_user).toBe("postgres");
  });
});

describe("writes are scoped too", () => {
  it("a user may update their own profile through withUser()", async () => {
    await withUser({ sub: userA }, (tx) =>
      tx
        .update(profiles)
        .set({ displayName: "Ana" })
        .where(eq(profiles.id, userA)),
    );

    const [row] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));
    expect(row.displayName).toBe("Ana");
  });

  it("a user's update of someone else's row silently affects nothing", async () => {
    await withUser({ sub: userB }, (tx) =>
      tx
        .update(profiles)
        .set({ displayName: "hacked" })
        .where(eq(profiles.id, userA)),
    );

    const [row] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));
    expect(row.displayName).toBe("Ana");
  });

  it("self-promotion is blocked through the scoped path", async () => {
    // Drizzle wraps driver errors, so the guard's own message is on `.cause`
    // rather than on the thrown error. Assert against the cause — asserting the
    // wrapper's message would pass for any failed query at all.
    const caught = await withUser({ sub: userA }, (tx) =>
      tx
        .update(profiles)
        .set({ role: "admin", status: "active" })
        .where(eq(profiles.id, userA)),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );

    expect(caught).not.toBeNull();
    expect(caught!.cause?.message ?? caught!.message).toMatch(
      /role and status cannot be changed by the account holder/i,
    );

    // And the row genuinely did not move.
    const [row] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));
    expect(row.role).toBe("member");
    expect(row.status).toBe("pending");
  });
});

/**
 * ===========================================================================
 * CRITERION 6 — "An admin's session reading any task table returns zero rows"
 * ===========================================================================
 *
 * This is the block the whole access model exists for, and the one phase 1 could
 * not write. devtask-pro promises that nobody sees anybody else's tasks — and
 * that the admin tier, which governs who may use the app at all, cannot see task
 * data even so. That is not a code-review promise about remembering a `.where()`;
 * it is `task_occurrence_select_own` in `0004`, and this is the evidence.
 *
 * Tasks are seeded through `dbAdmin` on purpose. Creating them through
 * `withUser()` would prove the insert policy and nothing else — if that policy
 * were broken, the fixtures would silently fail to exist and every assertion
 * below would pass against an empty table. Seeding privileged and reading scoped
 * keeps "can this user see it" the only variable.
 */
describe("task_occurrence — the criterion 6 proof", () => {
  let taskOfA: string;
  let taskOfB: string;

  beforeAll(async () => {
    const [a] = await dbAdmin
      .insert(taskOccurrence)
      .values({
        userId: userA,
        title: "A's private task",
        occursOn: "2026-08-06",
      })
      .returning({ id: taskOccurrence.id });

    const [b] = await dbAdmin
      .insert(taskOccurrence)
      .values({
        userId: userB,
        title: "B's private task",
        occursOn: "2026-08-06",
      })
      .returning({ id: taskOccurrence.id });

    taskOfA = a.id;
    taskOfB = b.id;
  });

  it("returns exactly the caller's own tasks", async () => {
    const rows = await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx.select().from(taskOccurrence),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(taskOfA);
    expect(rows[0].title).toBe("A's private task");
  });

  it("cannot see another user's task, even asked for by primary key", async () => {
    const rows = await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.select().from(taskOccurrence).where(eq(taskOccurrence.id, taskOfA)),
    );

    // Not an error — RLS filters silently. This is what makes a forgotten
    // `.where()` a non-event rather than a data leak.
    expect(rows).toHaveLength(0);
  });

  /**
   * CRITERION 6 ITSELF. The admin account is `role = 'admin', status = 'active'`
   * — the tier that approves signups and suspends accounts. It still sees none of
   * anyone else's task data, because `role` is an application concept and RLS
   * scopes on `auth.uid()`, which knows nothing about it.
   */
  it("an ADMIN session reading the task table returns ZERO rows", async () => {
    const all = await withUser({ sub: adminUser, email: EMAIL_ADMIN }, (tx) =>
      tx.select().from(taskOccurrence),
    );
    expect(all).toHaveLength(0);

    // And not by asking for a specific one either.
    for (const id of [taskOfA, taskOfB]) {
      const targeted = await withUser({ sub: adminUser }, (tx) =>
        tx.select().from(taskOccurrence).where(eq(taskOccurrence.id, id)),
      );
      expect(targeted).toHaveLength(0);
    }
  });

  it("dbAdmin still sees every task — the escalation path works", async () => {
    const ids = (await dbAdmin.select().from(taskOccurrence)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([taskOfA, taskOfB]));
  });

  it("a write aimed at someone else's task changes nothing", async () => {
    await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx
        .update(taskOccurrence)
        .set({ title: "hacked" })
        .where(eq(taskOccurrence.id, taskOfA)),
    );

    const [row] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.id, taskOfA));
    expect(row.title).toBe("A's private task");
  });

  it("a delete aimed at someone else's task removes nothing", async () => {
    await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.delete(taskOccurrence).where(eq(taskOccurrence.id, taskOfA)),
    );

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.id, taskOfA));
    expect(rows).toHaveLength(1);
  });

  /**
   * The `with check` on `task_occurrence_insert_own`. Without it, `using` alone
   * would let any authenticated caller create a row owned by somebody else —
   * planting work in another person's list rather than reading it, which no
   * select policy would ever catch.
   */
  it("cannot insert a task owned by somebody else", async () => {
    const attempt = await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx
        .insert(taskOccurrence)
        .values({ userId: userA, title: "planted", occursOn: "2026-08-06" }),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(attempt).not.toBeNull();

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.userId, userA));
    expect(rows).toHaveLength(1);
  });

  /**
   * The `with check` on `task_occurrence_update_own`. `using` decides which rows
   * may be targeted; without a matching `with check`, an owner could re-point
   * `user_id` at another account and hand the row away.
   */
  it("cannot give a task away by re-pointing user_id", async () => {
    await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx
        .update(taskOccurrence)
        .set({ userId: userB })
        .where(eq(taskOccurrence.id, taskOfA)),
    ).catch(() => {
      /* rejection is one acceptable outcome; a silent no-op is the other */
    });

    const [row] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.id, taskOfA));
    expect(row.userId).toBe(userA);
  });

  /**
   * The regression guard for the hole found and closed in `0004`.
   *
   * `postgres` — the role migrations run as — carries a default privilege
   * granting `TRUNCATE` to `anon` and `authenticated` on every new table in
   * `public`. TRUNCATE does not consult row level security, so before this was
   * revoked a single signed-in account could empty every other account's tasks
   * and not one policy above would have objected. Every assertion in this file
   * would still have passed.
   *
   * If a future migration reintroduces a blanket grant, this fails.
   */
  it("an authenticated session cannot TRUNCATE the table", async () => {
    const attempt = await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx.execute(sql`truncate table public.task_occurrence`),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /permission denied/i,
    );

    // And the rows are still there.
    const rows = await dbAdmin.select().from(taskOccurrence);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("an anonymous session cannot read the table at all", async () => {
    // `anon` holds no grant, so this fails on permission rather than returning
    // an empty set — a different failure mode from RLS filtering, and the one
    // that proves the grant block in 0004 is doing its job.
    const attempt = await dbAdmin
      .execute(sql`set local role anon; select count(*) from public.task_occurrence`)
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: { message?: string } },
      );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /permission denied/i,
    );
  });
});
