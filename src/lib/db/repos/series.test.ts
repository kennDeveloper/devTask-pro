import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withUser, type ScopedTx } from "@/lib/db/rls";
import { normaliseRule, type RecurrenceRule } from "@/lib/recurrence/rule";

import * as series from "./series";

/**
 * Unit tests for the series repo. **No database is touched.**
 *
 * Same harness and same reasoning as `occurrences.test.ts`: `withUser()` is
 * stubbed with a recorder, so what is asserted here is the *shape of the
 * statement each function composes*. That is the half a live database cannot
 * check for us — the local stack would happily accept a `softDelete` filtered on
 * `id` alone, because RLS would quietly save it.
 *
 * The complementary half is `tests/integration/rls-boundary.test.ts`.
 */

vi.mock("@/lib/db/rls", () => ({ withUser: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIMS = { sub: USER_ID, email: "member@example.com" };

interface RecordedCall {
  method: string;
  args: unknown[];
}

/** See the note in `occurrences.test.ts` — a thenable builder recorder. */
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

  get chain(): string[] {
    return this.calls.map((c) => c.method);
  }
}

const dialect = new PgDialect();

function shape(clause: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(clause as SQL);
  return { sql: query.sql.replace(/\$\d+/g, "?"), params: query.params };
}

let tx: QueryRecorder;

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

const WEEKLY: RecurrenceRule = normaliseRule({
  freq: "weekly",
  interval: 2,
  byweekday: ["MO", "WE"],
  monthMode: null,
  monthDay: null,
  nthWeek: null,
  nthWeekday: null,
  endsMode: "never",
  endsOn: null,
  endsCount: null,
});

const INPUT = {
  title: "Team standup",
  startsOn: "2026-01-05",
  deadlineTime: "09:00",
  rule: WEEKLY,
};

describe("every function goes through the RLS-scoped path", () => {
  it.each([
    ["listActive", () => series.listActive(CLAIMS)],
    ["findOwn", () => series.findOwn(CLAIMS, SERIES_ID)],
    ["create", () => series.create(CLAIMS, INPUT)],
    ["update", () => series.update(CLAIMS, SERIES_ID, INPUT)],
    ["softDelete", () => series.softDelete(CLAIMS, SERIES_ID)],
  ])("%s opens exactly one scoped transaction with the caller's claims", async (
    _name,
    call,
  ) => {
    arm([{ id: SERIES_ID }]);
    await call();

    expect(withUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withUser).mock.calls[0][0]).toEqual(CLAIMS);
  });

  it("never imports the RLS-bypassing connection", () => {
    // A source-level guard, because this is not something a mocked test can
    // observe: a single `dbAdmin` import would let a query escape the boundary
    // while every other assertion in this file still passed. This is acceptance
    // criterion 12.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "series.ts"), "utf8");

    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/dbAdmin|db\/client/);
  });
});

describe("listActive", () => {
  it("scopes to the caller and hides soft-deleted rows", async () => {
    await series.listActive(CLAIMS);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '("task_series"."user_id" = ? and "task_series"."deleted_at" is null)',
    );
    expect(params).toEqual([USER_ID]);
  });

  it("orders deterministically, so the list does not reshuffle between renders", async () => {
    await series.listActive(CLAIMS);
    expect(tx.argsOf("orderBy").map((term) => shape(term).sql)).toEqual([
      '"task_series"."created_at" desc',
      '"task_series"."id" asc',
    ]);
  });
});

describe("findOwn", () => {
  it("filters on id, user_id AND deleted_at", async () => {
    arm([{ id: SERIES_ID }]);
    await series.findOwn(CLAIMS, SERIES_ID);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '(("task_series"."id" = ? and "task_series"."user_id" = ?) and ' +
        '"task_series"."deleted_at" is null)',
    );
    expect(params).toEqual([SERIES_ID, USER_ID]);
  });

  it("returns null when nothing matched — 'not found', 'not yours' and 'deleted' look alike", async () => {
    arm([]);
    await expect(series.findOwn(CLAIMS, SERIES_ID)).resolves.toBeNull();
  });
});

describe("create", () => {
  it("takes the owner from the claims, never from the input", async () => {
    arm([{ id: SERIES_ID }]);
    await series.create(CLAIMS, { ...INPUT, userId: "someone-else" } as never);

    expect(tx.argOf("values")).toMatchObject({ userId: USER_ID });
    expect(tx.chain).toEqual(["insert", "values", "returning"]);
  });

  it("derives the rrule string from the rule rather than accepting one", async () => {
    // The typed columns and the RFC 5545 string have to describe the same rule.
    // The only way to guarantee that is for the module that writes both to
    // derive one from the other.
    arm([{ id: SERIES_ID }]);
    await series.create(CLAIMS, INPUT);

    expect(tx.argOf("values")).toMatchObject({
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
      freq: "weekly",
      interval: 2,
      byweekday: ["MO", "WE"],
    });
  });

  it("writes the null-shaped rule columns explicitly, not by omission", async () => {
    // 0005's cross-column CHECKs are two-way: a weekly rule must carry NULL in
    // the monthly columns, not merely leave them unset on an UPDATE.
    arm([{ id: SERIES_ID }]);
    await series.create(CLAIMS, INPUT);

    expect(tx.argOf("values")).toMatchObject({
      monthMode: null,
      monthDay: null,
      nthWeek: null,
      nthWeekday: null,
      endsOn: null,
      endsCount: null,
    });
  });

  it("never writes updated_at — the trigger in 0005 owns it", async () => {
    arm([{ id: SERIES_ID }]);
    await series.create(CLAIMS, INPUT);

    const values = tx.argOf("values") as Record<string, unknown>;
    expect(values).not.toHaveProperty("updatedAt");
    expect(values).not.toHaveProperty("createdAt");
    expect(values).not.toHaveProperty("deletedAt");
  });
});

describe("update", () => {
  it("filters on id, user_id and deleted_at", async () => {
    arm([{ id: SERIES_ID }]);
    await series.update(CLAIMS, SERIES_ID, INPUT);

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toContain('"task_series"."id" = ?');
    expect(sql).toContain('"task_series"."user_id" = ?');
    expect(sql).toContain('"task_series"."deleted_at" is null');
    expect(params).toEqual([SERIES_ID, USER_ID]);
  });

  it("replaces the whole rule, so the columns and the rrule cannot drift apart", async () => {
    arm([{ id: SERIES_ID }]);
    await series.update(CLAIMS, SERIES_ID, {
      ...INPUT,
      rule: normaliseRule({ ...WEEKLY, freq: "daily", interval: 3 }),
    });

    expect(tx.argOf("set")).toMatchObject({
      freq: "daily",
      interval: 3,
      // Cleared, because a daily rule carrying weekdays breaks
      // `task_series_weekly_days_check`.
      byweekday: [],
      rrule: "FREQ=DAILY;INTERVAL=3",
    });
  });

  /**
   * Acceptance criterion 15, expressed as a thing the repo does not do.
   *
   * Editing a rule writes nothing to `task_occurrence`. Untouched occurrences
   * were never rows and simply follow the new rule; touched ones are rows and
   * keep what they carry. Re-materialising here is the one way to destroy the
   * work the criterion exists to protect.
   */
  it("touches only task_series", async () => {
    arm([{ id: SERIES_ID }]);
    await series.update(CLAIMS, SERIES_ID, INPUT);

    expect(tx.chain).toEqual(["update", "set", "where", "returning"]);
    expect(shape(tx.argOf("where")).sql).not.toContain("task_occurrence");
  });

  it("returns null when nothing matched", async () => {
    arm([]);
    await expect(
      series.update(CLAIMS, SERIES_ID, INPUT),
    ).resolves.toBeNull();
  });
});

describe("softDelete", () => {
  it("stamps deleted_at rather than issuing a DELETE", async () => {
    // A hard delete would cascade the occurrences away through 0005's FK, taking
    // the recorded history criterion 17 says must survive.
    arm([{ id: SERIES_ID }]);
    await series.softDelete(CLAIMS, SERIES_ID);

    expect(tx.chain).toEqual(["update", "set", "where", "returning"]);
    expect(tx.argOf("set")).toHaveProperty("deletedAt");
    expect((tx.argOf("set") as { deletedAt: Date }).deletedAt).toBeInstanceOf(
      Date,
    );
  });

  it("filters on BOTH id and user_id", async () => {
    arm([{ id: SERIES_ID }]);
    await series.softDelete(CLAIMS, SERIES_ID);

    const { params } = shape(tx.argOf("where"));
    expect(params).toEqual([SERIES_ID, USER_ID]);
  });

  it("reports false the second time, rather than moving the tombstone", async () => {
    arm([]);
    await expect(series.softDelete(CLAIMS, SERIES_ID)).resolves.toBe(false);
    expect(shape(tx.argOf("where")).sql).toContain(
      '"task_series"."deleted_at" is null',
    );
  });
});
