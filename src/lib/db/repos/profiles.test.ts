import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { dbAdmin } from "@/lib/db/client";
import { withUser, type ScopedTx } from "@/lib/db/rls";

import * as profilesRepo from "./profiles";

/**
 * Unit tests for the profiles repo. **No database is touched.**
 *
 * Both connections are stubbed with recorders, so what these specs assert is the
 * *shape of the statement each function composes*. For the scoped half that is
 * belt-and-braces; for the admin half it is the only automated check there is,
 * because `dbAdmin` bypasses every policy and the database will not object to
 * anything written here. The complementary live proof is
 * `tests/integration/rls-boundary.test.ts`.
 *
 * The assertions that matter most:
 *
 *   - the admin projection names exactly eight columns and none of them is a
 *     task column (criterion 8, from the composition side);
 *   - `setAccountStatusAsAdmin` takes its row lock BEFORE it reads or writes,
 *     which is the whole reason the last-admin guard is not a lie under
 *     concurrency;
 *   - a re-approval does not rewrite an `approved_at` that is already set.
 */

vi.mock("@/lib/db/rls", () => ({ withUser: vi.fn() }));
vi.mock("@/lib/db/client", () => ({
  dbAdmin: {
    select: vi.fn(),
    transaction: vi.fn(),
  },
}));

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ADMIN_ID = "33333333-3333-4333-8333-333333333333";

interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * One builder chain — `select().from().where()` — recorded rather than run.
 *
 * Thenable, because awaiting a Drizzle builder is what executes it. Only the
 * methods the repo actually uses are defined, so a future change that reaches
 * for `groupBy()` fails loudly here instead of recording nothing.
 */
class ChainRecorder {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly rows: unknown[] = []) {}

  record(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }

  select(...args: unknown[]) {
    return this.record("select", args);
  }
  from(...args: unknown[]) {
    return this.record("from", args);
  }
  leftJoin(...args: unknown[]) {
    return this.record("leftJoin", args);
  }
  where(...args: unknown[]) {
    return this.record("where", args);
  }
  orderBy(...args: unknown[]) {
    return this.record("orderBy", args);
  }
  limit(...args: unknown[]) {
    return this.record("limit", args);
  }
  for(...args: unknown[]) {
    return this.record("for", args);
  }
  update(...args: unknown[]) {
    return this.record("update", args);
  }
  set(...args: unknown[]) {
    return this.record("set", args);
  }
  returning(...args: unknown[]) {
    return this.record("returning", args);
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }

  argOf(method: string): unknown {
    const call = this.calls.find((c) => c.method === method);
    if (!call) throw new Error(`the repo never called .${method}()`);
    return call.args[0];
  }

  argsOf(method: string): unknown[] {
    const call = this.calls.find((c) => c.method === method);
    if (!call) throw new Error(`the repo never called .${method}()`);
    return call.args;
  }

  has(method: string): boolean {
    return this.calls.some((c) => c.method === method);
  }

  get chain(): string[] {
    return this.calls.map((c) => c.method);
  }
}

/**
 * A connection handle that hands out a fresh `ChainRecorder` per statement and
 * keeps them in the order they were started — which is what lets a test assert
 * that the lock was taken before the write.
 */
class ConnectionRecorder {
  readonly chains: ChainRecorder[] = [];

  /** `results[n]` is what the nth statement resolves to. */
  constructor(private readonly results: unknown[][] = []) {}

  private start(method: string, args: unknown[]): ChainRecorder {
    const chain = new ChainRecorder(this.results[this.chains.length] ?? []);
    this.chains.push(chain);
    return chain.record(method, args);
  }

  select(...args: unknown[]) {
    return this.start("select", args);
  }
  update(...args: unknown[]) {
    return this.start("update", args);
  }

  /** The statements, in order, as their opening method — `["select","select","update"]`. */
  get order(): string[] {
    return this.chains.map((c) => c.calls[0].method);
  }
}

const dialect = new PgDialect();

/** Render a Drizzle condition to SQL text, with `$1`/`$2` flattened to `?`. */
function shape(clause: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(clause as SQL);
  return { sql: query.sql.replace(/\$\d+/g, "?"), params: query.params };
}

/** Arm `dbAdmin` so each statement resolves to the matching entry of `results`. */
function armAdmin(results: unknown[][] = []): ConnectionRecorder {
  const connection = new ConnectionRecorder(results);
  vi.mocked(dbAdmin.select).mockImplementation(
    ((...args: unknown[]) =>
      connection.select(...args)) as unknown as typeof dbAdmin.select,
  );
  vi.mocked(dbAdmin.transaction).mockImplementation((async (
    fn: (tx: unknown) => Promise<unknown>,
  ) => fn(connection)) as unknown as typeof dbAdmin.transaction);
  return connection;
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TARGET_ID,
    email: "member@example.com",
    displayName: null,
    timezone: "UTC",
    role: "member",
    status: "pending",
    approvedAt: null,
    approvedBy: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(withUser).mockReset();
  vi.mocked(dbAdmin.select).mockReset();
  vi.mocked(dbAdmin.transaction).mockReset();
});

// ---------------------------------------------------------------------------
// The scoped half
// ---------------------------------------------------------------------------

describe("the account holder's own row goes through withUser()", () => {
  it("scopes findOwn to the caller's claims and filters on their id", async () => {
    const tx = new ChainRecorder([profileRow()]);
    vi.mocked(withUser).mockImplementation(
      async (_claims, fn: (tx: ScopedTx) => Promise<unknown>) =>
        fn(tx as unknown as ScopedTx),
    );

    await profilesRepo.findOwn({ sub: ACTOR_ID, email: "a@example.com" });

    expect(vi.mocked(withUser).mock.calls[0][0]).toEqual({
      sub: ACTOR_ID,
      email: "a@example.com",
    });
    expect(shape(tx.argOf("where")).params).toEqual([ACTOR_ID]);
  });

  it("never reaches dbAdmin for a self read", async () => {
    const tx = new ChainRecorder([profileRow()]);
    vi.mocked(withUser).mockImplementation(
      async (_claims, fn: (tx: ScopedTx) => Promise<unknown>) =>
        fn(tx as unknown as ScopedTx),
    );

    await profilesRepo.findOwn({ sub: ACTOR_ID });

    expect(dbAdmin.select).not.toHaveBeenCalled();
    expect(dbAdmin.transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The admin half
// ---------------------------------------------------------------------------

describe("listAccountsAsAdmin", () => {
  it("composes select -> from -> leftJoin -> orderBy -> limit", async () => {
    const connection = armAdmin([[]]);
    await profilesRepo.listAccountsAsAdmin();

    expect(connection.chains[0].chain).toEqual([
      "select",
      "from",
      "leftJoin",
      "orderBy",
      "limit",
    ]);
  });

  /**
   * Criterion 8, from the composition side: the admin tier cannot render a task
   * count because it never asks for one. Asserted as an exact key set rather
   * than a `not.toContain`, so a column added to `profiles` in a later phase
   * cannot arrive on the admin's screen without this failing first.
   */
  it("selects exactly the eight account columns and nothing task-shaped", async () => {
    const connection = armAdmin([[]]);
    await profilesRepo.listAccountsAsAdmin();

    const projection = connection.chains[0].argOf("select") as Record<
      string,
      unknown
    >;
    expect(Object.keys(projection).sort()).toEqual([
      "approvedAt",
      "createdAt",
      "displayName",
      "email",
      "id",
      "lastSignInAt",
      "role",
      "status",
    ]);
  });

  it("orders the decision queue first, then newest first", async () => {
    const connection = armAdmin([[]]);
    await profilesRepo.listAccountsAsAdmin();

    const [first, second] = connection.chains[0].argsOf("orderBy");
    expect(shape(first).sql).toMatch(/case when .* = 'pending' then 0 else 1/i);
    expect(shape(second).sql).toMatch(/desc/i);
  });

  it("caps the result set", async () => {
    const connection = armAdmin([[]]);
    await profilesRepo.listAccountsAsAdmin();

    expect(connection.chains[0].argOf("limit")).toBe(
      profilesRepo.ACCOUNT_LIST_LIMIT,
    );
  });
});

describe("findAccountAsAdmin", () => {
  it("filters on the requested id and returns null when there is no row", async () => {
    const connection = armAdmin([[]]);
    const result = await profilesRepo.findAccountAsAdmin(TARGET_ID);

    expect(result).toBeNull();
    expect(shape(connection.chains[0].argOf("where")).params).toEqual([
      TARGET_ID,
    ]);
  });
});

describe("setAccountStatusAsAdmin", () => {
  /**
   * The ordering assertion this file exists for. A count taken outside the
   * write's transaction — or after it — makes the last-admin guard a lie the
   * moment two admins act at once.
   */
  it("takes the active-admin row lock before it reads the target or writes", async () => {
    const connection = armAdmin([
      [{ id: ACTOR_ID }, { id: TARGET_ID }],
      [profileRow({ role: "admin", status: "active" })],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "suspended",
      stampApproval: false,
    });

    expect(connection.chains[0].has("for")).toBe(true);
    expect(connection.chains[0].argOf("for")).toBe("update");
    expect(connection.order).toEqual(["select", "select", "update", "select"]);
  });

  it("locks on role = admin and status = active", async () => {
    const connection = armAdmin([
      [{ id: ACTOR_ID }, { id: TARGET_ID }],
      [profileRow()],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "active",
      stampApproval: true,
    });

    const { params } = shape(connection.chains[0].argOf("where"));
    expect(params).toEqual(["admin", "active"]);
  });

  it("reports a missing target as not_found without writing", async () => {
    const connection = armAdmin([[{ id: ACTOR_ID }], []]);

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "active",
      stampApproval: true,
    });

    expect(outcome).toEqual({ ok: false, reason: "not_found" });
    expect(connection.order).not.toContain("update");
  });

  it("refuses to revoke the last active administrator", async () => {
    const connection = armAdmin([
      // The target is the only active admin left.
      [{ id: TARGET_ID }],
      [profileRow({ role: "admin", status: "active" })],
    ]);

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "suspended",
      stampApproval: false,
    });

    expect(outcome).toEqual({ ok: false, reason: "last_admin" });
    expect(connection.order).not.toContain("update");
  });

  it("allows revoking an administrator while another remains active", async () => {
    const connection = armAdmin([
      [{ id: TARGET_ID }, { id: OTHER_ADMIN_ID }],
      [profileRow({ role: "admin", status: "active" })],
      [],
      [{ id: TARGET_ID }],
    ]);

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: OTHER_ADMIN_ID,
      targetId: TARGET_ID,
      status: "suspended",
      stampApproval: false,
    });

    expect(outcome.ok).toBe(true);
    expect(connection.order).toContain("update");
  });

  it("never blocks a change that leaves the account active", async () => {
    // Approving cannot empty the admin set, so the guard must not fire even
    // when the target is the only administrator there is.
    armAdmin([
      [{ id: TARGET_ID }],
      [profileRow({ role: "admin", status: "suspended" })],
      [],
      [{ id: TARGET_ID }],
    ]);

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "active",
      stampApproval: true,
    });

    expect(outcome.ok).toBe(true);
  });

  it("never blocks a change aimed at an ordinary member", async () => {
    armAdmin([
      [],
      [profileRow({ role: "member", status: "active" })],
      [],
      [{ id: TARGET_ID }],
    ]);

    const outcome = await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "suspended",
      stampApproval: false,
    });

    expect(outcome.ok).toBe(true);
  });

  it("stamps approved_at and approved_by on a first approval", async () => {
    const connection = armAdmin([
      [{ id: ACTOR_ID }],
      [profileRow({ approvedAt: null })],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "active",
      stampApproval: true,
    });

    const written = connection.chains[2].argOf("set") as Record<string, unknown>;
    expect(written.status).toBe("active");
    expect(written.approvedAt).toBeInstanceOf(Date);
    expect(written.approvedBy).toBe(ACTOR_ID);
  });

  /** Reinstating somebody who joined in March must not move their join date to today. */
  it("leaves an approved_at that is already set alone", async () => {
    const stamped = new Date("2026-03-01T00:00:00Z");
    const connection = armAdmin([
      [{ id: ACTOR_ID }],
      [profileRow({ approvedAt: stamped, status: "suspended" })],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "active",
      stampApproval: true,
    });

    const written = connection.chains[2].argOf("set") as Record<string, unknown>;
    expect(written).not.toHaveProperty("approvedAt");
    expect(written).not.toHaveProperty("approvedBy");
  });

  it("never writes updated_at — the 0002 trigger owns it", async () => {
    const connection = armAdmin([
      [{ id: ACTOR_ID }],
      [profileRow()],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "rejected",
      stampApproval: false,
    });

    expect(connection.chains[2].argOf("set")).not.toHaveProperty("updatedAt");
  });

  it("filters the write on the target id", async () => {
    const connection = armAdmin([
      [{ id: ACTOR_ID }],
      [profileRow()],
      [],
      [{ id: TARGET_ID }],
    ]);

    await profilesRepo.setAccountStatusAsAdmin({
      actorId: ACTOR_ID,
      targetId: TARGET_ID,
      status: "rejected",
      stampApproval: false,
    });

    expect(shape(connection.chains[2].argOf("where")).params).toEqual([
      TARGET_ID,
    ]);
  });
});

describe("countActiveAdminsAsAdmin", () => {
  it("counts rows that are both admin and active", async () => {
    const connection = armAdmin([[{ id: ACTOR_ID }, { id: OTHER_ADMIN_ID }]]);

    await expect(profilesRepo.countActiveAdminsAsAdmin()).resolves.toBe(2);
    expect(shape(connection.chains[0].argOf("where")).params).toEqual([
      "admin",
      "active",
    ]);
  });
});
