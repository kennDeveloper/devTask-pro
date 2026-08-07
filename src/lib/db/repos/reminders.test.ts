import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { withUser, type ScopedTx } from "@/lib/db/rls";

import * as reminders from "./reminders";

/**
 * Unit tests for the reminder-log repo. **No database is touched.**
 *
 * Same harness and the same reasoning as `occurrences.test.ts`: `withUser()` is
 * stubbed with a recorder, so what these assert is the shape of the statement
 * each function composes. The live proof that the policies refuse another user's
 * rows is `tests/integration/rls-boundary.test.ts`, and the live proof that a
 * second claim writes nothing is `tests/integration/reminders.test.ts`.
 */

vi.mock("@/lib/db/rls", () => ({ withUser: vi.fn() }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const OCCURRENCE_ID = "33333333-3333-4333-8333-333333333333";
const CLAIMS = { sub: USER_ID, email: "member@example.com" };
const DEADLINE = new Date("2026-08-07T09:00:00.000Z");

interface RecordedCall {
  method: string;
  args: unknown[];
}

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
  onConflictDoNothing(...args: unknown[]) {
    return this.record("onConflictDoNothing", args);
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

describe("every function goes through the RLS-scoped path", () => {
  it.each([
    ["listSentKeys", () => reminders.listSentKeys(CLAIMS, "2026-08-01")],
    ["listForSeries", () => reminders.listForSeries(CLAIMS, SERIES_ID)],
    [
      "claim",
      () =>
        reminders.claim(CLAIMS, {
          key: { kind: "series", seriesId: SERIES_ID, occursOn: "2026-08-07" },
          deadlineAt: DEADLINE,
        }),
    ],
  ])("%s opens withUser() with the caller's own claims", async (_name, call) => {
    await call();

    expect(withUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(withUser).mock.calls[0][0]).toEqual(CLAIMS);
  });

  it("never imports the RLS-bypassing connection", () => {
    // A source-level guard, for the reason `occurrences.test.ts` gives: this is
    // the one repo a background job calls, and a cron run with no session is
    // exactly where somebody would reach for the owner connection. A single
    // `dbAdmin` import here would let the job scan every account's rows while
    // every other assertion in this file still passed.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "reminders.ts"), "utf8");

    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/dbAdmin|db\/client/);
  });

  it("exports no update or delete — the ledger is append-only", () => {
    // 0007 grants `authenticated` neither privilege, so a function for either
    // would fail at the database. The absence is the point: "a reminder was
    // already sent" is the fact criterion 21 rests on.
    expect(Object.keys(reminders).sort()).toEqual([
      "claim",
      "listForSeries",
      "listSentKeys",
      "reminderKeyToken",
    ]);
  });
});

describe("claim", () => {
  const seriesKey = {
    kind: "series" as const,
    seriesId: SERIES_ID,
    occursOn: "2026-08-07",
  };
  const occurrenceKey = {
    kind: "occurrence" as const,
    occurrenceId: OCCURRENCE_ID,
    occursOn: "2026-08-07",
  };

  it("inserts, does nothing on conflict, and reads back what it wrote", () => {
    // The order is the criterion: without `.returning()` an INSERT that
    // conflicted would be indistinguishable from one that won, because both are
    // perfectly successful statements.
    arm([{ id: "written" }]);
    return reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE }).then(() => {
      expect(tx.chain).toEqual([
        "insert",
        "values",
        "onConflictDoNothing",
        "returning",
      ]);
    });
  });

  it("is true only when a row was actually written", async () => {
    arm([{ id: "written" }]);
    await expect(
      reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE }),
    ).resolves.toBe(true);

    arm([]);
    await expect(
      reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE }),
    ).resolves.toBe(false);
  });

  it("writes the series identity and leaves occurrence_id null", async () => {
    await reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE });

    expect(tx.argOf("values")).toEqual({
      userId: USER_ID,
      seriesId: SERIES_ID,
      occurrenceId: null,
      occursOn: "2026-08-07",
      deadlineAt: DEADLINE,
    });
  });

  it("writes the occurrence identity and leaves series_id null", async () => {
    await reminders.claim(CLAIMS, { key: occurrenceKey, deadlineAt: DEADLINE });

    expect(tx.argOf("values")).toEqual({
      userId: USER_ID,
      seriesId: null,
      occurrenceId: OCCURRENCE_ID,
      occursOn: "2026-08-07",
      deadlineAt: DEADLINE,
    });
  });

  it("never sends sent_at — the column default is the single definition", async () => {
    await reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE });

    expect(tx.argOf("values")).not.toHaveProperty("sentAt");
  });

  it("takes the owner from the claims, never from the caller's input", async () => {
    // There is no `userId` field on `ClaimReminderInput`, which is what makes
    // this true by construction rather than by review.
    await reminders.claim(CLAIMS, { key: seriesKey, deadlineAt: DEADLINE });

    expect((tx.argOf("values") as { userId: string }).userId).toBe(CLAIMS.sub);
  });
});

describe("reminderKeyToken", () => {
  it("distinguishes the two kinds so a set cannot conflate them", () => {
    const asSeries = reminders.reminderKeyToken({
      kind: "series",
      seriesId: SERIES_ID,
      occursOn: "2026-08-07",
    });
    const asOccurrence = reminders.reminderKeyToken({
      kind: "occurrence",
      occurrenceId: SERIES_ID,
      occursOn: "2026-08-07",
    });

    expect(asSeries).not.toBe(asOccurrence);
  });

  it("gives one series date one token, whoever asks", () => {
    // This is what makes criterion 6 fall out: the token does not change when
    // the date is later materialised, because it never mentioned a row id.
    const key = {
      kind: "series" as const,
      seriesId: SERIES_ID,
      occursOn: "2026-08-07",
    };

    expect(reminders.reminderKeyToken(key)).toBe(
      reminders.reminderKeyToken({ ...key }),
    );
  });

  it("ignores the date for a one-off, whose row id is already unique", () => {
    expect(
      reminders.reminderKeyToken({
        kind: "occurrence",
        occurrenceId: OCCURRENCE_ID,
        occursOn: "2026-08-07",
      }),
    ).toBe(
      reminders.reminderKeyToken({
        kind: "occurrence",
        occurrenceId: OCCURRENCE_ID,
        occursOn: "2026-01-01",
      }),
    );
  });
});

describe("listSentKeys", () => {
  it("scopes to the caller and bounds by occurs_on", async () => {
    await reminders.listSentKeys(CLAIMS, "2026-08-01");

    const { sql, params } = shape(tx.argOf("where"));
    expect(sql).toBe(
      '("reminder_log"."user_id" = ? and "reminder_log"."occurs_on" >= ?)',
    );
    expect(params).toEqual([USER_ID, "2026-08-01"]);
  });

  it("reads each row back as the key it was written under", async () => {
    arm([
      {
        id: "a",
        userId: USER_ID,
        seriesId: SERIES_ID,
        occurrenceId: null,
        occursOn: "2026-08-07",
        deadlineAt: DEADLINE,
        sentAt: DEADLINE,
      },
      {
        id: "b",
        userId: USER_ID,
        seriesId: null,
        occurrenceId: OCCURRENCE_ID,
        occursOn: "2026-08-08",
        deadlineAt: DEADLINE,
        sentAt: DEADLINE,
      },
    ]);

    await expect(reminders.listSentKeys(CLAIMS, "2026-08-01")).resolves.toEqual([
      { kind: "series", seriesId: SERIES_ID, occursOn: "2026-08-07" },
      { kind: "occurrence", occurrenceId: OCCURRENCE_ID, occursOn: "2026-08-08" },
    ]);
  });
});
