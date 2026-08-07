import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import * as occurrencesRepo from "@/lib/db/repos/occurrences";
import * as seriesRepo from "@/lib/db/repos/series";
import { taskOccurrence, taskSeries } from "@/lib/db/schema";
import * as feed from "@/lib/tasks/feed";
import { normaliseRule } from "@/lib/recurrence/rule";

/**
 * THE RECURRENCE LIFECYCLE, AGAINST A REAL DATABASE.
 *
 * Phase 3's criteria 3, 4 and 5 (the brief's 14, 15 and 17) are all statements
 * about what happens to *other* occurrences when you touch one, edit the rule,
 * or delete the series. Unit tests prove the merge and the expander in isolation;
 * this proves the whole path — repo, RLS, the partial unique index, the triggers
 * and the feed — behaves the way those criteria describe.
 *
 * Runs through `withUser()` throughout, never `dbAdmin`, except to read back what
 * the database actually holds. That is deliberate: reading the result privileged
 * and writing it scoped keeps "did the policy allow this" the only variable.
 *
 * Requires the local stack: `pnpm db:start`. Run with `pnpm test:integration`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const stamp = Date.now();
const EMAIL_A = `series-a-${stamp}@devtask.local`;
const EMAIL_B = `series-b-${stamp}@devtask.local`;

let admin: SupabaseClient;
let userA: string;
let userB: string;
let claimsA: { sub: string; email: string };
let claimsB: { sub: string; email: string };

/** Weekly on Mondays and Wednesdays from Monday 5 January 2026, due 09:00. */
const MON_WED = normaliseRule({
  freq: "weekly",
  interval: 1,
  byweekday: ["MO", "WE"],
  monthMode: null,
  monthDay: null,
  nthWeek: null,
  nthWeekday: null,
  endsMode: "never",
  endsOn: null,
  endsCount: null,
});

const STARTS_ON = "2026-01-05";
/** A window wide enough to hold the first four occurrences and nothing else. */
const WINDOW = { from: "2026-01-05", to: "2026-01-14" };

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
  claimsA = { sub: userA, email: EMAIL_A };
  claimsB = { sub: userB, email: EMAIL_B };
});

afterAll(async () => {
  for (const id of [userA, userB]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
});

/** A fresh series owned by A, with every occurrence still untouched. */
async function freshSeries(title = "Team standup") {
  // Cleared between tests so each one reasons about its own rows rather than
  // about whatever the previous one left materialised.
  await dbAdmin.delete(taskOccurrence).where(eq(taskOccurrence.userId, userA));
  await dbAdmin.delete(taskSeries).where(eq(taskSeries.userId, userA));

  return seriesRepo.create(claimsA, {
    title,
    startsOn: STARTS_ON,
    deadlineTime: "09:00",
    rule: MON_WED,
  });
}

/** The dates the feed shows for A's series in the fixed window. */
async function occurrenceDays(series: { id: string }): Promise<string[]> {
  const live = await seriesRepo.listActive(claimsA);
  const rows = await occurrencesRepo.listForSeries(claimsA, [series.id]);

  const projected = live.flatMap((s) => feed.seriesOccurrences(s, WINDOW, "UTC"));
  return feed
    .mergeOccurrences(rows.map(feed.fromRow), projected)
    .map((o) => o.occursOn)
    .sort();
}

describe("creating a rule writes exactly one row", () => {
  it("stores the typed columns and the serialised rrule together", async () => {
    const series = await freshSeries();

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, series.id));

    expect(row.freq).toBe("weekly");
    expect(row.byweekday).toEqual(["MO", "WE"]);
    // Derived by the repo from the columns — never accepted from a caller, so
    // the two cannot describe different rules.
    expect(row.rrule).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(row.deletedAt).toBeNull();
  });

  it("materialises nothing — every occurrence is a projection until touched", async () => {
    const series = await freshSeries();

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(rows).toHaveLength(0);

    // And yet the list shows four: Mon 5, Wed 7, Mon 12, Wed 14.
    await expect(occurrenceDays(series)).resolves.toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-12",
      "2026-01-14",
    ]);
  });
});

/**
 * ===========================================================================
 * CRITERION 14 — "setting occurrence #3 persists that row and leaves the rest"
 * ===========================================================================
 */
describe("touching one occurrence", () => {
  it("writes exactly one row and leaves its neighbours projections", async () => {
    const series = await freshSeries();

    // #3 is Monday 12 January.
    const materialised = await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-12" },
      { status: "in_progress", progressPct: 60 },
      "UTC",
    );

    expect(materialised).not.toBeNull();
    expect(materialised!.status).toBe("in_progress");
    expect(materialised!.progressPct).toBe(60);

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].occursOn).toBe("2026-01-12");

    // The list is unchanged in shape — four occurrences, one of them now a row.
    await expect(occurrenceDays(series)).resolves.toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-12",
      "2026-01-14",
    ]);
  });

  it("freezes the deadline computed for that date", async () => {
    const series = await freshSeries();

    const row = await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-12" },
      { status: "in_progress" },
      "America/New_York",
    );

    // 09:00 in New York on 12 January is 14:00Z. Stored, not recomputed, so a
    // later timezone change moves the untouched future and leaves this alone.
    expect(row!.deadlineAt?.toISOString()).toBe("2026-01-12T14:00:00.000Z");
  });

  it("is idempotent — the partial unique index makes a second touch an update", async () => {
    const series = await freshSeries();
    const ref = {
      kind: "virtual" as const,
      seriesId: series.id,
      occursOn: "2026-01-12",
    };

    await feed.materializeOccurrence(claimsA, ref, { progressPct: 20 }, "UTC");
    const second = await feed.materializeOccurrence(
      claimsA,
      ref,
      { progressPct: 80 },
      "UTC",
    );

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));

    expect(rows).toHaveLength(1);
    expect(second!.progressPct).toBe(80);
  });

  it("does not reset the work already recorded when only the other field is sent", async () => {
    const series = await freshSeries();
    const ref = {
      kind: "virtual" as const,
      seriesId: series.id,
      occursOn: "2026-01-12",
    };

    await feed.materializeOccurrence(
      claimsA,
      ref,
      { status: "in_progress", progressPct: 60 },
      "UTC",
    );
    const after = await feed.materializeOccurrence(
      claimsA,
      ref,
      { status: "done" },
      "UTC",
    );

    // The 60% survives being marked done — criterion 12, through the upsert.
    expect(after!.status).toBe("done");
    expect(after!.progressPct).toBe(60);
    // And `completed_at` came from the trigger in 0004, not from this code.
    expect(after!.completedAt).not.toBeNull();
  });

  it("refuses a date the rule does not name", async () => {
    const series = await freshSeries();

    // Tuesday the 6th. The rule names Mondays and Wednesdays.
    await expect(
      feed.materializeOccurrence(
        claimsA,
        { kind: "virtual", seriesId: series.id, occursOn: "2026-01-06" },
        { status: "done" },
        "UTC",
      ),
    ).resolves.toBeNull();

    const rows = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(rows).toHaveLength(0);
  });

  it("refuses a series that is not the caller's", async () => {
    const series = await freshSeries();

    await expect(
      feed.materializeOccurrence(
        claimsB,
        { kind: "virtual", seriesId: series.id, occursOn: "2026-01-12" },
        { status: "done" },
        "UTC",
      ),
    ).resolves.toBeNull();
  });
});

/**
 * ===========================================================================
 * CRITERION 15 — "editing the rule changes only future UNTOUCHED occurrences"
 * ===========================================================================
 */
describe("editing the rule", () => {
  it("moves the untouched occurrences and keeps the touched one exactly as it was", async () => {
    const series = await freshSeries();

    // Record real work against Wednesday 7 January.
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-07" },
      { status: "in_progress", progressPct: 60 },
      "UTC",
    );

    // Now the rule fires on Tuesdays and Thursdays instead.
    const edited = await seriesRepo.update(claimsA, series.id, {
      title: "Team standup",
      startsOn: STARTS_ON,
      deadlineTime: "09:00",
      rule: normaliseRule({ ...MON_WED, byweekday: ["TU", "TH"] }),
    });
    expect(edited).not.toBeNull();

    const days = await occurrenceDays(series);

    // The new rule's dates — Tue 6, Thu 8, Tue 13, Thu 15 (15 is outside the
    // window) — plus the touched Wednesday, which is now on a date the rule does
    // not name and is still there because it holds recorded work.
    expect(days).toEqual([
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-13",
    ]);

    const [kept] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(kept.occursOn).toBe("2026-01-07");
    expect(kept.status).toBe("in_progress");
    expect(kept.progressPct).toBe(60);
  });

  it("writes nothing to task_occurrence at all", async () => {
    const series = await freshSeries();
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-07" },
      { progressPct: 40 },
      "UTC",
    );

    const [before] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));

    await seriesRepo.update(claimsA, series.id, {
      title: "Renamed entirely",
      startsOn: "2026-02-02",
      deadlineTime: null,
      rule: normaliseRule({ ...MON_WED, freq: "daily", byweekday: [] }),
    });

    const [after] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));

    // Same row, same title, same deadline, same `updated_at` — the trigger did
    // not even fire, because nothing wrote to it.
    expect(after.title).toBe(before.title);
    expect(after.deadlineAt?.toISOString()).toBe(
      before.deadlineAt?.toISOString(),
    );
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it("cannot be done by another user", async () => {
    const series = await freshSeries();

    await expect(
      seriesRepo.update(claimsB, series.id, {
        title: "hacked",
        startsOn: STARTS_ON,
        deadlineTime: null,
        rule: MON_WED,
      }),
    ).resolves.toBeNull();

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, series.id));
    expect(row.title).toBe("Team standup");
  });
});

/**
 * ===========================================================================
 * CRITERION 17 — "deleting a series removes untouched future occurrences and
 * leaves completed history intact"
 * ===========================================================================
 */
describe("deleting the series", () => {
  it("takes the untouched occurrences with it and leaves the recorded ones", async () => {
    const series = await freshSeries();

    // Finish Monday the 5th.
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-05" },
      { status: "done", progressPct: 100 },
      "UTC",
    );

    await expect(seriesRepo.softDelete(claimsA, series.id)).resolves.toBe(true);

    // The three untouched dates are gone; the completed one remains.
    await expect(occurrenceDays(series)).resolves.toEqual(["2026-01-05"]);

    const [kept] = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(kept.status).toBe("done");
    expect(kept.progressPct).toBe(100);
    expect(kept.completedAt).not.toBeNull();
  });

  it("keeps the series row, so the surviving occurrence still resolves its FK", async () => {
    // A hard delete would cascade the occurrences away through 0005's foreign
    // key — which is exactly the history the criterion says must remain.
    const series = await freshSeries();
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: "2026-01-05" },
      { status: "done" },
      "UTC",
    );
    await seriesRepo.softDelete(claimsA, series.id);

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, series.id));
    expect(row.deletedAt).not.toBeNull();

    const occurrences = await dbAdmin
      .select()
      .from(taskOccurrence)
      .where(eq(taskOccurrence.seriesId, series.id));
    expect(occurrences).toHaveLength(1);
  });

  it("stops the series appearing in listActive, so nothing is projected", async () => {
    const series = await freshSeries();
    await seriesRepo.softDelete(claimsA, series.id);

    await expect(seriesRepo.listActive(claimsA)).resolves.toEqual([]);
    await expect(seriesRepo.findOwn(claimsA, series.id)).resolves.toBeNull();
  });

  it("reports false the second time rather than moving the tombstone", async () => {
    const series = await freshSeries();
    await seriesRepo.softDelete(claimsA, series.id);
    await expect(seriesRepo.softDelete(claimsA, series.id)).resolves.toBe(false);
  });

  it("cannot be done by another user", async () => {
    const series = await freshSeries();

    await expect(seriesRepo.softDelete(claimsB, series.id)).resolves.toBe(false);

    const [row] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.id, series.id));
    expect(row.deletedAt).toBeNull();
  });
});

describe("the five end conditions survive a round trip through the database", () => {
  beforeEach(async () => {
    await dbAdmin.delete(taskOccurrence).where(eq(taskOccurrence.userId, userA));
    await dbAdmin.delete(taskSeries).where(eq(taskSeries.userId, userA));
  });

  it.each([
    [
      "never",
      normaliseRule({ ...MON_WED, endsMode: "never" }),
      "FREQ=WEEKLY;BYDAY=MO,WE",
      4,
    ],
    [
      "on a date",
      normaliseRule({ ...MON_WED, endsMode: "on", endsOn: "2026-01-07" }),
      "FREQ=WEEKLY;UNTIL=20260107;BYDAY=MO,WE",
      2,
    ],
    [
      "after a count",
      normaliseRule({ ...MON_WED, endsMode: "after", endsCount: 3 }),
      "FREQ=WEEKLY;COUNT=3;BYDAY=MO,WE",
      3,
    ],
    [
      "monthly by date",
      normaliseRule({
        ...MON_WED,
        freq: "monthly",
        byweekday: [],
        monthMode: "by_date",
        monthDay: 7,
      }),
      "FREQ=MONTHLY;BYMONTHDAY=7",
      1,
    ],
    [
      "monthly on the last Friday",
      normaliseRule({
        ...MON_WED,
        freq: "monthly",
        byweekday: [],
        monthMode: "by_nth_weekday",
        nthWeek: -1,
        nthWeekday: "FR",
      }),
      "FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1",
      0,
    ],
  ])(
    "%s stores, serialises and expands correctly",
    async (_label, rule, expectedRrule, expectedInWindow) => {
      const created = await seriesRepo.create(claimsA, {
        title: "End condition",
        startsOn: STARTS_ON,
        rule,
      });

      const [row] = await dbAdmin
        .select()
        .from(taskSeries)
        .where(eq(taskSeries.id, created.id));

      // The columns satisfied 0005's six cross-column CHECKs, and the stored
      // string describes the same rule the columns do.
      expect(row.rrule).toBe(expectedRrule);
      expect(feed.seriesOccurrences(row, WINDOW, "UTC")).toHaveLength(
        expectedInWindow,
      );
    },
  );
});
