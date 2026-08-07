import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withUser, type ScopedTx } from "@/lib/db/rls";

import * as occurrences from "./occurrences";

/**
 * Unit tests for the occurrences repo. **No database is touched.**
 *
 * `withUser()` is replaced with a stub that hands the callback a recorder in place of a
 * transaction, so what these specs assert is the *shape of the statement each function
 * composes* — which table, which `where`, which order, which columns are written. That
 * is the half of the contract a database cannot check for us: the local stack would
 * happily accept a `remove()` that filtered on `id` alone, because RLS would quietly
 * save it. Here that omission is visible.
 *
 * The complementary half — that the policies really do refuse another user's rows — is
 * `tests/integration/rls-boundary.test.ts`, which needs the live stack and runs
 * separately. Neither suite replaces the other.
 */

vi.mock("@/lib/db/rls", () => ({ withUser: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const CLAIMS = { sub: USER_ID, email: "member@example.com" };

/** One call the repo made on its transaction handle, in order. */
interface RecordedCall {
  method: string;
  args: unknown[];
}

/**
 * A stand-in for a Drizzle transaction that records the builder chain instead of
 * running it.
 *
 * Every method returns `this`, and the object is thenable, which is exactly the surface
 * a Drizzle query builder presents — `await tx.select().from(t).where(c)` works because
 * awaiting the builder executes it. Only the methods the repo actually uses are
 * defined: if a future change reaches for `limit()` or `groupBy()`, these tests fail
 * loudly with "not a function" rather than silently recording nothing.
 */
class QueryRecorder {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly rows: unknown[] = []) {}

  private record(method: string, args: unknown[]): this {
    this.calls.push({ method, args });
    return this;
  }

  select(...args: unknown[]) {
    return this.record("select", args);
  }
  from(...args: unknown[]) {
    return this.record("from", args);
  }
  where(...args: unknown[]) {
    return this.record("where", args);
  }
  orderBy(...args: unknown[]) {
    return this.record("orderBy", args);
  }
  insert(...args: unknown[]) {
    return this.record("insert", args);
  }
  values(...args: unknown[]) {
    return this.record("values", args);
  }
  update(...args: unknown[]) {
    return this.record("update", args);
  }
  set(...args: unknown[]) {
    return this.record("set", args);
  }
  delete(...args: unknown[]) {
    return this.record("delete", args);
  }
  returning(...args: unknown[]) {
    return this.record("returning", args);
  }
  onConflictDoUpdate(...args: unknown[]) {
    return this.record("onConflictDoUpdate", args);
  }

  then<TResult1 = unknown, TResult2 = never>(
    onFulfilled?:
      | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
      | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.rows).then(onFulfilled, onRejected);
  }

  /** The single argument passed to `method`, e.g. the `where` condition. */
  argOf(method: string): unknown {
    const call = this.calls.find((c) => c.method === method);
    if (!call) throw new Error(`the repo never called .${method}()`);
    return call.args[0];
  }

  /** All arguments passed to `method`, e.g. the several terms of an `orderBy`. */
  argsOf(method: string): unknown[] {
    const call = this.calls.find((c) => c.method === method);
    if (!call) throw new Error(`the repo never called .${method}()`);
    return call.args;
  }

  /** The chain in order — `["select", "from", "where", "orderBy"]` and so on. */
  get chain(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const dialect = new PgDialect();

/**
 * Render a Drizzle condition to SQL text, with `$1`/`$2` flattened to `?`.
 *
 * Normalising the placeholders is what lets one condition be compared against a
 * fragment of a larger one: the same expression gets different parameter numbers
 * depending on what it is `and`-ed with, and that numbering is not what any of these
 * assertions are about.
 */
function shape(clause: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(clause as SQL);
  return { sql: query.sql.replace(/\$\d+/g, "?"), params: query.params };
}

let tx: QueryRecorder;

/** Arm the mocked `withUser` to hand `fn` a recorder that resolves to `rows`. */
function arm(rows: unknown[] = []): QueryRecorder {
  tx = new QueryRecorder(rows);
  vi.mocked(withUser).mockImplementation(
    async (_claims, fn: (tx: ScopedTx) => Promise<unknown>) =>
      fn(tx as unknown as ScopedTx),
  );
  return tx;
}

beforeEach(() => {
  vi.mocked(withUser).mockReset();
  arm();
});

describe("every function goes through the RLS-scoped path", () => {
  it("opens withUser() with the caller's own claims", async () => {
    await occurrences.listAll(CLAIMS);

    expect(withUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withUser).mock.calls[0][0]).toEqual(CLAIMS);
  });

  it.each([
    ["listForDay", () => occurrences.listForDay(CLAIMS, "2026-08-06")],
    ["listOverdue", () => occurrences.listOverdue(CLAIMS, new Date())],
    ["listAll", () => occurrences.listAll(CLAIMS)],
    [
      "create",
      () => occurrences.create(CLAIMS, { title: "t", occursOn: "2026-08-06" }),
    ],
    ["update", () => occurrences.update(CLAIMS, TASK_ID, { title: "t" })],
    ["remove", () => occurrences.remove(CLAIMS, TASK_ID)],
  ])("%s opens exactly one scoped transaction", async (_name, call) => {
    arm([{ id: TASK_ID }]);
    await call();
    expect(withUser).toHaveBeenCalledTimes(1);
  });

  it("never imports the RLS-bypassing connection", () => {
    // A source-level guard, because this is not something a mocked test can observe:
    // a single `dbAdmin` import here would let a query escape the boundary while every
    // other assertion in this file still passed. `dbAdmin` has no legitimate caller in
    // a user-facing repo — see the header of `src/lib/db/client.ts`.
    // `fileURLToPath` is given a string, not a URL object: under the jsdom environment
    // the global `URL` is jsdom's, and Node rejects an instance of it as "not of scheme
    // file" even when it plainly is.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "occurrences.ts"), "utf8");

    // Only the import block is examined — the prose above it names `dbAdmin` precisely
    // in order to say it must not appear, and a naive whole-file match would forbid
    // explaining the rule.
    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/dbAdmin|db\/client/);
  });
});

describe("overdueCondition", () => {
  const now = new Date("2026-08-06T09:00:00.000Z");

  it("is exactly `deadline_at is not null and deadline_at < now and status <> done`", () => {
    const { sql, params } = shape(occurrences.overdueCondition(now));

    expect(sql).toBe(
      '("task_occurrence"."deadline_at" is not null and ' +
        '"task_occurrence"."deadline_at" < ? and ' +
        '"task_occurrence"."status" <> ?)',
    );
    expect(new Date(params[0] as string).toISOString()).toBe(now.toISOString());
    expect(params[1]).toBe("done");
  });

  it("keeps `is not null`, which matches the partial index predicate in 0004", () => {
    // Redundant to three-valued logic, load-bearing for the planner: the index
    // `task_occurrence_user_deadline_idx` is defined WHERE deadline_at is not null and
    // status <> 'done', and Postgres has to see the same terms to use it.
    expect(shape(occurrences.overdueCondition(now)).sql).toContain(
      "is not null",
    );
  });
});

describe("listForDay", () => {
  it("filters on user_id and the given day", async () => {
    await occurrences.listForDay(CLAIMS, "2026-08-06");

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '("task_occurrence"."user_id" = ? and "task_occurrence"."occurs_on" = ?)',
    );
    expect(params).toEqual([USER_ID, "2026-08-06"]);
  });

  it("passes the day through as a bare YYYY-MM-DD string, not a Date", async () => {
    // `occurs_on` is a `date` column in `mode: "string"`. A Date here would attach a
    // time and a zone to a calendar square that has neither.
    await occurrences.listForDay(CLAIMS, "2026-08-06");

    const [, day] = shape(tx.argOf("where")).params;
    expect(day).toBe("2026-08-06");
    expect(day).not.toBeInstanceOf(Date);
  });

  it("orders by deadline then creation, so undated tasks sort last", async () => {
    await occurrences.listForDay(CLAIMS, "2026-08-06");

    // ASC puts NULLs last in Postgres, which is the wanted reading: timed work first.
    expect(tx.argsOf("orderBy").map((term) => shape(term).sql)).toEqual([
      '"task_occurrence"."deadline_at" asc',
      '"task_occurrence"."created_at" asc',
    ]);
  });

  it("returns the rows the transaction produced", async () => {
    const rows = [{ id: TASK_ID, title: "Write the repo" }];
    arm(rows);

    await expect(occurrences.listForDay(CLAIMS, "2026-08-06")).resolves.toBe(
      rows,
    );
  });
});

describe("listOverdue", () => {
  const now = new Date("2026-08-06T09:00:00.000Z");

  it("scopes to the caller and reuses the exported overdue predicate verbatim", async () => {
    await occurrences.listOverdue(CLAIMS, now);

    const where = shape(tx.argOf("where"));
    expect(where.sql).toContain('"task_occurrence"."user_id" = ?');
    // Not "an equivalent predicate" — the same one. This is the assertion that would
    // fail if a second, drifting definition of overdue were inlined here.
    expect(where.sql).toContain(shape(occurrences.overdueCondition(now)).sql);
    expect(where.params[0]).toBe(USER_ID);
    expect(where.params[2]).toBe("done");
  });

  it("is not restricted to any one day", async () => {
    // Last Tuesday's unfinished task is overdue today; filtering by occurs_on would
    // hide exactly the rows this bucket exists to surface.
    await occurrences.listOverdue(CLAIMS, now);
    expect(shape(tx.argOf("where")).sql).not.toContain("occurs_on");
  });

  it("orders most-overdue first", async () => {
    await occurrences.listOverdue(CLAIMS, now);
    expect(tx.argsOf("orderBy").map((term) => shape(term).sql)).toEqual([
      '"task_occurrence"."deadline_at" asc',
    ]);
  });
});

describe("listAll", () => {
  it("scopes to the caller with no further filter", async () => {
    await occurrences.listAll(CLAIMS);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe('"task_occurrence"."user_id" = ?');
    expect(params).toEqual([USER_ID]);
  });

  it("orders newest day first", async () => {
    await occurrences.listAll(CLAIMS);
    expect(tx.argsOf("orderBy").map((term) => shape(term).sql)).toEqual([
      '"task_occurrence"."occurs_on" desc',
      '"task_occurrence"."created_at" desc',
    ]);
  });
});

describe("create", () => {
  const input = {
    title: "Write the repo",
    occursOn: "2026-08-06",
    deadlineAt: new Date("2026-08-06T17:00:00.000Z"),
  };

  it("takes the owner from the claims and returns the inserted row", async () => {
    const row = { id: TASK_ID, userId: USER_ID };
    arm([row]);

    await expect(occurrences.create(CLAIMS, input)).resolves.toBe(row);
    expect(tx.chain).toEqual(["insert", "values", "returning"]);
    expect(tx.argOf("values")).toMatchObject({ userId: USER_ID });
  });

  it("ignores a user_id smuggled in through the input", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.create(CLAIMS, {
      ...input,
      userId: OTHER_USER_ID,
    } as never);

    // The insert policy's WITH CHECK would refuse this anyway; the point is that the
    // attempt never reaches the database looking like a legitimate row.
    expect(tx.argOf("values")).toMatchObject({ userId: USER_ID });
  });

  it("writes neither completed_at nor updated_at — both are trigger-maintained", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.create(CLAIMS, { ...input, status: "done" });

    const values = tx.argOf("values") as Record<string, unknown>;
    expect(values).not.toHaveProperty("completedAt");
    expect(values).not.toHaveProperty("updatedAt");
    expect(values).not.toHaveProperty("createdAt");
  });

  it("omits status and progress so the column defaults in 0004 apply", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.create(CLAIMS, input);

    const values = tx.argOf("values") as Record<string, unknown>;
    expect(values).not.toHaveProperty("status");
    expect(values).not.toHaveProperty("progressPct");
  });

  it("sends status and progress when the caller did supply them", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.create(CLAIMS, {
      ...input,
      status: "in_progress",
      progressPct: 40,
    });

    expect(tx.argOf("values")).toMatchObject({
      status: "in_progress",
      progressPct: 40,
    });
  });

  it("normalises omitted optionals to null rather than leaving them absent", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.create(CLAIMS, {
      title: "No deadline",
      occursOn: "2026-08-06",
    });

    expect(tx.argOf("values")).toMatchObject({
      description: null,
      deadlineAt: null,
    });
  });
});

describe("update", () => {
  it("filters on BOTH id and user_id", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.update(CLAIMS, TASK_ID, { title: "Renamed" });

    const { sql, params } = shape(tx.argOf("where"));
    // `id` alone would only be safe by virtue of RLS. This clause is what makes the
    // statement correct on its own terms — "update task 123" and never "update
    // anyone's task 123".
    expect(sql).toBe(
      '("task_occurrence"."id" = ? and "task_occurrence"."user_id" = ?)',
    );
    expect(params).toEqual([TASK_ID, USER_ID]);
  });

  it("sets only the keys present in the patch", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.update(CLAIMS, TASK_ID, { progressPct: 60 });

    expect(tx.argOf("set")).toEqual({ progressPct: 60 });
  });

  it("distinguishes an explicit null from an omitted field", async () => {
    // `undefined` means "leave alone", `null` means "clear it". Clearing a deadline is
    // a real edit, and collapsing the two would make it unexpressible.
    arm([{ id: TASK_ID }]);
    await occurrences.update(CLAIMS, TASK_ID, { deadlineAt: null });

    const values = tx.argOf("set") as Record<string, unknown>;
    expect(values).toEqual({ deadlineAt: null });
    expect(values).not.toHaveProperty("description");
  });

  it("writes neither completed_at nor updated_at, even when moving to done", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.update(CLAIMS, TASK_ID, { status: "done" });

    const values = tx.argOf("set") as Record<string, unknown>;
    expect(values).toEqual({ status: "done" });
    expect(values).not.toHaveProperty("completedAt");
    expect(values).not.toHaveProperty("updatedAt");
  });

  it("returns null when no row matched — 'not found' and 'not yours' look the same", async () => {
    arm([]);
    await expect(
      occurrences.update(CLAIMS, TASK_ID, { title: "Renamed" }),
    ).resolves.toBeNull();
  });

  it("reads the row back instead of issuing an empty UPDATE", async () => {
    // Drizzle throws on `.set({})`, and a partial-update boundary can legitimately
    // produce a patch where every field is undefined. Nothing changed, so nothing is
    // written and `updated_at` correctly does not move.
    const row = { id: TASK_ID };
    arm([row]);

    await expect(occurrences.update(CLAIMS, TASK_ID, {})).resolves.toBe(row);
    expect(tx.chain).toEqual(["select", "from", "where"]);
    expect(shape(tx.argOf("where")).params).toEqual([TASK_ID, USER_ID]);
  });
});

describe("remove", () => {
  it("filters on BOTH id and user_id", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.remove(CLAIMS, TASK_ID);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '("task_occurrence"."id" = ? and "task_occurrence"."user_id" = ?)',
    );
    expect(params).toEqual([TASK_ID, USER_ID]);
  });

  it("reports true only when a row actually left", async () => {
    arm([{ id: TASK_ID }]);
    await expect(occurrences.remove(CLAIMS, TASK_ID)).resolves.toBe(true);
  });

  it("reports false when nothing matched", async () => {
    // A DELETE matching no rows is a perfectly successful statement; without
    // `.returning()` this could only report "the statement ran".
    arm([]);
    await expect(occurrences.remove(CLAIMS, TASK_ID)).resolves.toBe(false);
    expect(tx.chain).toContain("returning");
  });
});

const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("listForSeries", () => {
  it("scopes to the caller and to the given series", async () => {
    await occurrences.listForSeries(CLAIMS, [SERIES_ID]);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '("task_occurrence"."user_id" = ? and "task_occurrence"."series_id" in (?))',
    );
    expect(params).toEqual([USER_ID, SERIES_ID]);
  });

  /**
   * The asymmetry that keeps criterion 15 working: a virtual occurrence is a
   * projection and needs bounds, but a row exists because a person acted on that
   * date. Windowing here would hide a row on a date the current rule no longer
   * names — which is precisely the row the criterion says must survive.
   */
  it("is not windowed by date", async () => {
    await occurrences.listForSeries(CLAIMS, [SERIES_ID]);
    expect(shape(tx.argOf("where")).sql).not.toContain("occurs_on\" >");
    expect(shape(tx.argOf("where")).sql).not.toContain("occurs_on\" <");
  });

  it("short-circuits on an empty list rather than issuing `in ()`", async () => {
    await expect(occurrences.listForSeries(CLAIMS, [])).resolves.toEqual([]);
    expect(withUser).not.toHaveBeenCalled();
  });
});

describe("materialize", () => {
  const input = {
    seriesId: SERIES_ID,
    occursOn: "2026-01-19",
    title: "Team standup",
    deadlineAt: new Date("2026-01-19T09:00:00.000Z"),
  };

  it("upserts against the partial unique index from 0005", async () => {
    // One statement, so first-touch cannot lose a race to itself. `targetWhere`
    // is required rather than decorative: Postgres will not infer a *partial*
    // index as a conflict target without being given its predicate.
    arm([{ id: TASK_ID }]);
    await occurrences.materialize(CLAIMS, input);

    expect(tx.chain).toEqual([
      "insert",
      "values",
      "onConflictDoUpdate",
      "returning",
    ]);

    const config = tx.argOf("onConflictDoUpdate") as {
      target: unknown[];
      targetWhere: unknown;
    };
    expect(config.target).toHaveLength(2);
    expect(shape(config.targetWhere).sql).toBe(
      '"task_occurrence"."series_id" is not null',
    );
  });

  it("takes the owner from the claims", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.materialize(CLAIMS, {
      ...input,
      userId: OTHER_USER_ID,
    } as never);

    expect(tx.argOf("values")).toMatchObject({
      userId: USER_ID,
      seriesId: SERIES_ID,
      occursOn: "2026-01-19",
    });
  });

  /**
   * Acceptance criteria 14 and 15. A row that already exists is a row somebody
   * has worked on, and an upsert that reset status and progress to the series
   * template on every touch would destroy the more valuable half of it.
   */
  it("does not reset status or progress when the caller did not send them", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.materialize(CLAIMS, input);

    const set = tx.argOf("onConflictDoUpdate") as { set: Record<string, unknown> };
    expect(set.set).not.toHaveProperty("status");
    expect(set.set).not.toHaveProperty("progressPct");
  });

  it("writes status and progress on both branches when they are the touch", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.materialize(CLAIMS, {
      ...input,
      status: "in_progress",
      progressPct: 60,
    });

    expect(tx.argOf("values")).toMatchObject({
      status: "in_progress",
      progressPct: 60,
    });
    const config = tx.argOf("onConflictDoUpdate") as {
      set: Record<string, unknown>;
    };
    expect(config.set).toMatchObject({
      status: "in_progress",
      progressPct: 60,
    });
  });

  it("never writes completed_at or updated_at — both are trigger-maintained", async () => {
    arm([{ id: TASK_ID }]);
    await occurrences.materialize(CLAIMS, { ...input, status: "done" });

    const values = tx.argOf("values") as Record<string, unknown>;
    const config = tx.argOf("onConflictDoUpdate") as {
      set: Record<string, unknown>;
    };
    for (const bag of [values, config.set]) {
      expect(bag).not.toHaveProperty("completedAt");
      expect(bag).not.toHaveProperty("updatedAt");
    }
  });
});
