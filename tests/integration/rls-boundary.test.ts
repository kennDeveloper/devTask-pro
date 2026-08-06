import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq, sql } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import { withUser } from "@/lib/db/rls";
import { profiles } from "@/lib/db/schema";

/**
 * THE RLS BOUNDARY PROOF.
 *
 * devtask-pro promises that an admin never sees another person's task data. That
 * promise is only worth anything if it is enforced by the database rather than by
 * remembering to write a `.where()` clause. This spec is the evidence.
 *
 * Phase 1 has no task tables yet, so the mechanism is proven here against
 * `profiles` — the same policies, the same `withUser()` path, the same roles.
 * Phase 2 re-points this harness at `task_occurrence` and criterion 6 of
 * `docs/gsd/devtask-pro-v1.md` closes for real. Until then it stays open.
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
