import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import * as profilesRepo from "@/lib/db/repos/profiles";
import { withUser } from "@/lib/db/rls";
import { profiles, taskOccurrence, taskSeries } from "@/lib/db/schema";

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

/**
 * ===========================================================================
 * CRITERION 6, AGAIN — this time for `task_series`
 * ===========================================================================
 *
 * `AGENTS.md`: *"When a phase adds a table holding user data, add a block there
 * too."* Phase 3 adds `task_series`, which holds a title and notes — task data
 * by any reading — so the same proof has to hold for it: an admin's session sees
 * zero rows.
 *
 * Appended rather than woven into the block above. The `task_occurrence` block
 * is the criterion-6 proof for the table the product promise is about and stands
 * on its own; this is the same proof for the table phase 3 introduced, plus the
 * two things only a real database can demonstrate — that the partial unique
 * index in 0005 actually rejects a duplicate `(series_id, occurs_on)`, and that
 * it does *not* catch one-off tasks, which all share `series_id IS NULL`.
 *
 * Series are seeded through `dbAdmin` for the reason the block above gives:
 * creating them through `withUser()` would prove the insert policy and nothing
 * else, and if that policy were broken the fixtures would silently fail to exist
 * and every assertion below would pass against an empty table.
 */
describe("task_series — the criterion 6 proof for the recurrence table", () => {
  let seriesOfA: string;
  let seriesOfB: string;

  /** The minimum a `task_series` row needs to satisfy 0005's CHECKs. */
  function weekly(userId: string, title: string) {
    return {
      userId,
      title,
      freq: "weekly" as const,
      interval: 1,
      byweekday: ["MO" as const],
      startsOn: "2026-01-05",
      deadlineTime: "09:00",
      endsMode: "never" as const,
      rrule: "FREQ=WEEKLY;BYDAY=MO",
    };
  }

  beforeAll(async () => {
    const [a] = await dbAdmin
      .insert(taskSeries)
      .values(weekly(userA, "A's private rule"))
      .returning({ id: taskSeries.id });

    const [b] = await dbAdmin
      .insert(taskSeries)
      .values(weekly(userB, "B's private rule"))
      .returning({ id: taskSeries.id });

    seriesOfA = a.id;
    seriesOfB = b.id;
  });

  it("returns exactly the caller's own series", async () => {
    const rows = await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx.select().from(taskSeries),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(seriesOfA);
    expect(rows[0].title).toBe("A's private rule");
  });

  it("cannot see another user's series, even asked for by primary key", async () => {
    const rows = await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.select().from(taskSeries).where(eq(taskSeries.id, seriesOfA)),
    );

    expect(rows).toHaveLength(0);
  });

  /**
   * CRITERION 6 ITSELF, for this table. The admin account is
   * `role = 'admin', status = 'active'` — the tier that approves signups and
   * suspends accounts. It sees none of anyone else's repeat rules, because
   * `role` is an application concept and RLS scopes on `auth.uid()`.
   */
  it("an ADMIN session reading task_series returns ZERO rows", async () => {
    const all = await withUser({ sub: adminUser, email: EMAIL_ADMIN }, (tx) =>
      tx.select().from(taskSeries),
    );
    expect(all).toHaveLength(0);

    for (const id of [seriesOfA, seriesOfB]) {
      const targeted = await withUser({ sub: adminUser }, (tx) =>
        tx.select().from(taskSeries).where(eq(taskSeries.id, id)),
      );
      expect(targeted).toHaveLength(0);
    }
  });

  it("dbAdmin still sees every series — the escalation path works", async () => {
    const ids = (await dbAdmin.select().from(taskSeries)).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([seriesOfA, seriesOfB]));
  });

  it("a write aimed at someone else's series changes nothing", async () => {
    await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx
        .update(taskSeries)
        .set({ title: "hacked" })
        .where(eq(taskSeries.id, seriesOfA)),
    );

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, seriesOfA));
    expect(row.title).toBe("A's private rule");
  });

  it("a soft delete aimed at someone else's series marks nothing", async () => {
    // The application deletes by stamping `deleted_at`, so this is the shape the
    // real attack would take — an UPDATE, not a DELETE.
    await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx
        .update(taskSeries)
        .set({ deletedAt: new Date() })
        .where(eq(taskSeries.id, seriesOfA)),
    );

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, seriesOfA));
    expect(row.deletedAt).toBeNull();
  });

  it("a hard delete aimed at someone else's series removes nothing", async () => {
    await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.delete(taskSeries).where(eq(taskSeries.id, seriesOfA)),
    );

    const rows = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, seriesOfA));
    expect(rows).toHaveLength(1);
  });

  /** The `with check` on `task_series_insert_own`. */
  it("cannot create a series owned by somebody else", async () => {
    const attempt = await withUser({ sub: userB, email: EMAIL_B }, (tx) =>
      tx.insert(taskSeries).values(weekly(userA, "planted")),
    ).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(attempt).not.toBeNull();

    const rows = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.userId, userA));
    expect(rows).toHaveLength(1);
  });

  /** The `with check` on `task_series_update_own`. */
  it("cannot give a series away by re-pointing user_id", async () => {
    await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx
        .update(taskSeries)
        .set({ userId: userB })
        .where(eq(taskSeries.id, seriesOfA)),
    ).catch(() => {
      /* rejection is one acceptable outcome; a silent no-op is the other */
    });

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, seriesOfA));
    expect(row.userId).toBe(userA);
  });

  /**
   * The regression guard 0004 wrote and 0005 inherits.
   *
   * `postgres` used to carry a default privilege granting TRUNCATE to `anon` and
   * `authenticated` on every new table in `public`, and TRUNCATE does not
   * consult row level security. 0004 revoked the default, which is why
   * `task_series` — created after it — starts with an empty ACL. If a future
   * migration reintroduces a blanket grant, this fails.
   */
  it("an authenticated session cannot TRUNCATE the table", async () => {
    const attempt = await withUser({ sub: userA, email: EMAIL_A }, (tx) =>
      tx.execute(sql`truncate table public.task_series cascade`),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /permission denied/i,
    );

    const rows = await dbAdmin.select().from(taskSeries);
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("an anonymous session cannot read the table at all", async () => {
    // `anon` holds no grant, so this fails on permission rather than returning
    // an empty set — a different failure mode from RLS filtering, and the one
    // that proves the grant block in 0005 is doing its job.
    const attempt = await dbAdmin
      .execute(sql`set local role anon; select count(*) from public.task_series`)
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

/**
 * ===========================================================================
 * THE PARTIAL UNIQUE INDEX — phase 3's criterion 7
 * ===========================================================================
 *
 * *"The partial unique index actually prevents a duplicate `(series_id,
 * occurs_on)` — asserted, not assumed."*
 *
 * Both halves matter. The index is what makes `materialize()`'s ON CONFLICT a
 * single statement that cannot lose a race to itself; the `where series_id is
 * not null` is what stops it catching one-off tasks, which all share a NULL
 * `series_id` and are routinely created several to a day.
 */
describe("task_occurrence_series_day_uniq", () => {
  let series: string;

  beforeAll(async () => {
    const [row] = await dbAdmin
      .insert(taskSeries)
      .values({
        userId: userA,
        title: "Uniqueness fixture",
        freq: "daily",
        interval: 1,
        startsOn: "2026-02-01",
        endsMode: "never",
        rrule: "FREQ=DAILY",
      })
      .returning({ id: taskSeries.id });

    series = row.id;
  });

  it("rejects a second occurrence of the same series on the same day", async () => {
    await dbAdmin.insert(taskOccurrence).values({
      userId: userA,
      seriesId: series,
      title: "First touch",
      occursOn: "2026-02-02",
    });

    const attempt = await dbAdmin
      .insert(taskOccurrence)
      .values({
        userId: userA,
        seriesId: series,
        title: "Second touch",
        occursOn: "2026-02-02",
      })
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: { message?: string } },
      );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /task_occurrence_series_day_uniq|duplicate key/i,
    );
  });

  it("still allows the same series on a different day", async () => {
    await expect(
      dbAdmin.insert(taskOccurrence).values({
        userId: userA,
        seriesId: series,
        title: "Another day",
        occursOn: "2026-02-03",
      }),
    ).resolves.toBeDefined();
  });

  /**
   * The `where` clause, doing its job. Without it every one-off would share the
   * key `(NULL, occurs_on)` — which NULLs would in fact keep distinct, but only
   * by relying on that. The predicate says the intent instead of depending on it,
   * and this is the assertion that would catch its removal.
   */
  it("does NOT catch one-off tasks sharing a day", async () => {
    for (const title of ["One-off A", "One-off B", "One-off C"]) {
      await expect(
        dbAdmin.insert(taskOccurrence).values({
          userId: userA,
          title,
          occursOn: "2026-02-04",
        }),
      ).resolves.toBeDefined();
    }
  });

  /**
   * The FK 0004 deferred and 0005 added. A `series_id` pointing at nothing would
   * be an occurrence with no rule behind it — invisible in every list, because
   * the feed builds projections from series rows.
   */
  it("refuses an occurrence pointing at a series that does not exist", async () => {
    const attempt = await dbAdmin
      .insert(taskOccurrence)
      .values({
        userId: userA,
        seriesId: "00000000-0000-4000-8000-000000000000",
        title: "Orphan",
        occursOn: "2026-02-05",
      })
      .then(
        () => null,
        (e: unknown) => e as Error & { cause?: { message?: string } },
      );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /task_occurrence_series_fk|foreign key/i,
    );
  });
});

/**
 * ===========================================================================
 * PHASE 5 — THE ADMIN TIER, EXERCISED THROUGH ITS OWN ESCALATED PATH
 * ===========================================================================
 *
 * The block above proves that an admin's *scoped session* sees no task rows.
 * Phase 5 adds the code that deliberately does not use a scoped session:
 * `…AsAdmin` in `src/lib/db/repos/profiles.ts` runs on `dbAdmin`, which bypasses
 * every policy above. So the question this block asks is the one the earlier
 * blocks cannot: **now that a privileged path exists, does it stay inside its
 * fence?**
 *
 * Three things are proven here that nothing else can prove:
 *
 *   1. What the admin tier can actually see is account metadata — asserted by
 *      running the real function against a real database and reading its keys,
 *      rather than by trusting the projection's source.
 *   2. `auth.users`, which the account list joins for `last_sign_in_at`, is
 *      unreachable from the `authenticated` role. No migration grants it and
 *      none should.
 *   3. The last-active-admin guard survives two admins revoking each other at
 *      the same instant — the case a count-then-update would get wrong and no
 *      unit test with a mocked transaction can reach.
 *
 * Appended as its own block. The file's earlier sections are phase 1's and
 * phase 2's and are left exactly as they were.
 */
describe("the phase-5 admin tier stays inside its fence", () => {
  /**
   * Every account that was an active administrator before this block ran, other
   * than our own fixture. They are parked so the guard tests are deterministic —
   * "the last active admin" is a global fact, and a bootstrap admin from
   * `pnpm admin:create` or a leftover from an e2e run would otherwise decide
   * whether the guard fires. Restored in `afterAll`.
   */
  let parkedAdmins: string[] = [];
  let secondAdmin: string;

  beforeAll(async () => {
    secondAdmin = await createUser(`rls-admin2-${stamp}@devtask.local`);
    await dbAdmin
      .update(profiles)
      .set({ role: "admin", status: "active" })
      .where(eq(profiles.id, secondAdmin));

    const rows = await dbAdmin.execute<{ id: string }>(
      sql`select id from public.profiles where role = 'admin' and status = 'active'`,
    );

    parkedAdmins = rows
      .map((row) => row.id)
      .filter((id) => id !== adminUser && id !== secondAdmin);

    for (const id of parkedAdmins) {
      await dbAdmin
        .update(profiles)
        .set({ status: "suspended" })
        .where(eq(profiles.id, id));
    }
  });

  afterAll(async () => {
    for (const id of parkedAdmins) {
      await dbAdmin
        .update(profiles)
        .set({ status: "active" })
        .where(eq(profiles.id, id));
    }
    if (secondAdmin) await admin.auth.admin.deleteUser(secondAdmin);
  });

  it("lists accounts across every user — the escalation genuinely escalates", async () => {
    const accounts = await profilesRepo.listAccountsAsAdmin();
    const ids = accounts.map((account) => account.id);

    expect(ids).toEqual(expect.arrayContaining([userA, userB, adminUser]));
  });

  /**
   * CRITERION 8, against the database rather than against the source. The list
   * an admin receives carries account metadata and nothing else — no task
   * column arrives because none is fetched, and this reads the actual returned
   * object rather than trusting the projection literal.
   */
  it("returns account metadata only — no task field, by any name", async () => {
    const accounts = await profilesRepo.listAccountsAsAdmin();
    const [account] = accounts.filter((row) => row.id === userA);

    expect(Object.keys(account).sort()).toEqual([
      "approvedAt",
      "createdAt",
      "displayName",
      "email",
      "id",
      "lastSignInAt",
      "role",
      "status",
    ]);

    // Every row, not just the sampled one — and over the *keys*, because the
    // values are user data. The fixture addresses end in `@devtask.local`, so a
    // sweep over serialised values would flag the word "task" in an email and
    // prove nothing about the projection.
    const keys = new Set(accounts.flatMap((row) => Object.keys(row)));
    expect([...keys].sort()).toEqual([
      "approvedAt",
      "createdAt",
      "displayName",
      "email",
      "id",
      "lastSignInAt",
      "role",
      "status",
    ]);

    for (const key of keys) {
      for (const word of ["task", "occurrence", "progress", "deadline"]) {
        expect(
          key.toLowerCase(),
          `the account list carries a "${key}" field`,
        ).not.toContain(word);
      }
    }
  });

  /**
   * `last_sign_in_at` is joined from `auth.users`, which is Supabase's table
   * rather than ours. It needs no policy because the role every user-facing
   * query runs as holds no grant on it at all — a different and stronger
   * failure mode than RLS returning zero rows.
   */
  it("keeps auth.users unreachable from the authenticated role", async () => {
    const attempt = await withUser({ sub: adminUser }, (tx) =>
      tx.execute(sql`select count(*) from auth.users`),
    ).then(
      () => null,
      (e: unknown) => e as Error & { cause?: { message?: string } },
    );

    expect(attempt).not.toBeNull();
    expect(attempt!.cause?.message ?? attempt!.message).toMatch(
      /permission denied/i,
    );
  });

  it("moves somebody else's status, which their own session cannot", async () => {
    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: adminUser,
      targetId: userA,
      status: "active",
      stampApproval: true,
    });

    expect(outcome.ok).toBe(true);

    const [row] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));

    expect(row.status).toBe("active");
    // The audit fields the admin path is the only writer of.
    expect(row.approvedAt).not.toBeNull();
    expect(row.approvedBy).toBe(adminUser);
  });

  it("does not rewrite an approval stamp on a later reinstatement", async () => {
    const [before] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: adminUser,
      targetId: userA,
      status: "suspended",
      stampApproval: false,
    });
    await profilesRepo.setAccountStatusAsAdmin({
      actorId: secondAdmin,
      targetId: userA,
      status: "active",
      stampApproval: true,
    });

    const [after] = await dbAdmin
      .select()
      .from(profiles)
      .where(eq(profiles.id, userA));

    // Reinstating somebody must not move the date they originally joined.
    expect(after.approvedAt?.toISOString()).toBe(
      before.approvedAt?.toISOString(),
    );
    expect(after.approvedBy).toBe(adminUser);
  });

  it("refuses to revoke the last active administrator", async () => {
    // Park the second one, leaving exactly one.
    await profilesRepo.setAccountStatusAsAdmin({
      actorId: adminUser,
      targetId: secondAdmin,
      status: "suspended",
      stampApproval: false,
    });

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: secondAdmin,
      targetId: adminUser,
      status: "suspended",
      stampApproval: false,
    });

    expect(outcome).toEqual({ ok: false, reason: "last_admin" });
    await expect(profilesRepo.countActiveAdminsAsAdmin()).resolves.toBe(1);

    // Put the second one back for the race below.
    await profilesRepo.setAccountStatusAsAdmin({
      actorId: adminUser,
      targetId: secondAdmin,
      status: "active",
      stampApproval: true,
    });
  });

  /**
   * THE ONE A MOCKED TRANSACTION CANNOT REACH.
   *
   * Two administrators revoking each other at the same instant. Written the
   * obvious way — count, then update — both transactions read a count of two,
   * both conclude they are fine, and the application is left with no
   * administrators at all and no way to make one without a shell.
   *
   * `setAccountStatusAsAdmin` takes `for update` on the active-admin set before
   * it reads or writes anything, so the second transaction blocks; under READ
   * COMMITTED, Postgres re-evaluates the predicate after the lock is granted,
   * the row it was counting on is no longer active, and it correctly refuses.
   *
   * The primary claim is the invariant rather than which caller won: **an
   * administrator remains.**
   */
  it("survives two administrators revoking each other at the same instant", async () => {
    await expect(profilesRepo.countActiveAdminsAsAdmin()).resolves.toBe(2);

    const results = await Promise.allSettled([
      profilesRepo.setAccountStatusAsAdmin({
        actorId: adminUser,
        targetId: secondAdmin,
        status: "suspended",
        stampApproval: false,
      }),
      profilesRepo.setAccountStatusAsAdmin({
        actorId: secondAdmin,
        targetId: adminUser,
        status: "suspended",
        stampApproval: false,
      }),
    ]);

    const succeeded = results.filter(
      (result) => result.status === "fulfilled" && result.value.ok,
    );

    expect(succeeded).toHaveLength(1);
    await expect(
      profilesRepo.countActiveAdminsAsAdmin(),
    ).resolves.toBeGreaterThanOrEqual(1);

    // Restore both, so `afterAll`'s cleanup and any later run start level.
    for (const id of [adminUser, secondAdmin]) {
      await dbAdmin
        .update(profiles)
        .set({ status: "active" })
        .where(eq(profiles.id, id));
    }
  });

  /**
   * CRITERION 6, RE-ASSERTED AFTER THE FACT. Everything above ran on `dbAdmin`.
   * None of it changed what an admin's own *session* is allowed to see, because
   * RLS scopes on `auth.uid()` and the privileged path never touched a policy.
   */
  it("still shows an admin session zero task rows, after all of the above", async () => {
    const rows = await withUser({ sub: adminUser, email: EMAIL_ADMIN }, (tx) =>
      tx.select().from(taskOccurrence),
    );

    expect(rows).toHaveLength(0);
  });
});
