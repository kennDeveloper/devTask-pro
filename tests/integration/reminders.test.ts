import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { eq } from "drizzle-orm";

import { dbAdmin } from "@/lib/db/client";
import * as occurrencesRepo from "@/lib/db/repos/occurrences";
import * as remindersRepo from "@/lib/db/repos/reminders";
import * as seriesRepo from "@/lib/db/repos/series";
import { profiles, reminderLog, taskOccurrence, taskSeries } from "@/lib/db/schema";
import { normaliseRule } from "@/lib/recurrence/rule";
import { runReminders } from "@/lib/reminders/run";
import * as feed from "@/lib/tasks/feed";

import { clearInbox, messagesFor } from "../../e2e/helpers/mailpit";

/**
 * THE REMINDER JOB, AGAINST A REAL DATABASE AND A REAL MAIL SERVER.
 *
 * This is where the brief's criteria **21** (a reminder sends at most once,
 * proven by running the job twice) and **22** (no reminder for an occurrence
 * already done) are actually closed. Unit tests prove the selection and the
 * orchestration in isolation; this proves the whole path — the partial unique
 * index, RLS on `reminder_log`, the feed, and SMTP into the stack's own catcher.
 *
 * It also proves the thing the phase was designed around, which no unit test
 * can: that **running the job leaves `task_occurrence` untouched**, so criteria
 * 15 and 17 still hold afterwards.
 *
 * Seeding goes through `dbAdmin` only to arrange fixtures and to read back what
 * the database really holds. Everything the job does runs through the ordinary
 * scoped path, which is the point.
 *
 * Requires the local stack **with SMTP exposed** — `[local_smtp] smtp_port` in
 * `supabase/config.toml`, which needs a stack restart rather than a `db:reset`.
 * Run with `pnpm test:integration`.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const stamp = Date.now();
const EMAIL_A = `rem-a-${stamp}@devtask.local`;
const EMAIL_B = `rem-b-${stamp}@devtask.local`;

let admin: SupabaseClient;
let userA: string;
let userB: string;
let claimsA: { sub: string; email: string };

/**
 * A fixed instant for every run, so nothing here depends on when it is executed.
 *
 * `runReminders` takes `now` as a parameter precisely so this is possible — a
 * job that read the clock itself could only be tested by waiting.
 */
const NOW = new Date("2026-04-15T12:00:00.000Z");
/** Ten minutes ahead of `NOW`; with a 30-minute lead, squarely inside the window. */
const DEADLINE = new Date("2026-04-15T12:10:00.000Z");
const TODAY = "2026-04-15";
const LEAD = 30;

/** Daily from `TODAY`, so the series names today and every day after. */
const DAILY = normaliseRule({
  freq: "daily",
  interval: 1,
  byweekday: [],
  monthMode: null,
  monthDay: null,
  nthWeek: null,
  nthWeekday: null,
  endsMode: "never",
  endsOn: null,
  endsCount: null,
});

async function createUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "correct-horse-battery-staple",
    email_confirm: true,
  });
  if (error) throw error;
  return data.user!.id;
}

/**
 * Make an account reachable by the job.
 *
 * Profiles are created `pending` by the 0002 trigger, and
 * `listActiveRecipientsAsAdmin` deliberately skips anything but `active` — so
 * without this the whole suite would pass vacuously by sending nothing.
 * Timezone is pinned to UTC so the wall clocks in these fixtures are the
 * instants they look like.
 */
async function activate(id: string): Promise<void> {
  await dbAdmin
    .update(profiles)
    .set({ status: "active", timezone: "UTC" })
    .where(eq(profiles.id, id));
}

/** Everything this suite created, gone — so each test reasons about its own rows. */
async function reset(): Promise<void> {
  for (const id of [userA, userB]) {
    await dbAdmin.delete(reminderLog).where(eq(reminderLog.userId, id));
    await dbAdmin.delete(taskOccurrence).where(eq(taskOccurrence.userId, id));
    await dbAdmin.delete(taskSeries).where(eq(taskSeries.userId, id));
  }
  await clearInbox();
}

/** A one-off owned by A, due inside the window. */
async function oneOff(overrides: Partial<{ status: "todo" | "done"; deadlineAt: Date | null; reminderLeadMinutes: number | null }> = {}) {
  return occurrencesRepo.create(claimsA, {
    title: "Ship the migration",
    occursOn: TODAY,
    deadlineAt: DEADLINE,
    reminderLeadMinutes: LEAD,
    ...overrides,
  });
}

/** A daily series owned by A whose occurrences are due at 12:10 UTC. */
async function dailySeries() {
  return seriesRepo.create(claimsA, {
    title: "Team standup",
    startsOn: TODAY,
    deadlineTime: "12:10",
    reminderLeadMinutes: LEAD,
    rule: DAILY,
  });
}

/** The rows `task_occurrence` holds for A, as a comparable snapshot. */
async function occurrenceSnapshot() {
  const rows = await dbAdmin
    .select()
    .from(taskOccurrence)
    .where(eq(taskOccurrence.userId, userA))
    .orderBy(taskOccurrence.occursOn);

  return rows.map((row) => ({
    id: row.id,
    seriesId: row.seriesId,
    occursOn: row.occursOn,
    status: row.status,
    progressPct: row.progressPct,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

beforeAll(async () => {
  admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  userA = await createUser(EMAIL_A);
  userB = await createUser(EMAIL_B);
  claimsA = { sub: userA, email: EMAIL_A };

  await activate(userA);
  await activate(userB);
});

afterAll(async () => {
  for (const id of [userA, userB]) {
    if (id) await admin.auth.admin.deleteUser(id);
  }
  await clearInbox();
});

beforeEach(reset);

describe("criterion 21 — a reminder sends at most once", () => {
  it("sends once for a one-off, and running the job again sends nothing", async () => {
    await oneOff();

    const first = await runReminders(NOW);
    const second = await runReminders(NOW);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    // The second run did not even claim — the ledger already had the key.
    expect(second.claimed).toBe(0);

    const ledger = await dbAdmin
      .select()
      .from(reminderLog)
      .where(eq(reminderLog.userId, userA));
    expect(ledger).toHaveLength(1);

    expect(await messagesFor(EMAIL_A)).toHaveLength(1);
  });

  it("sends once for an occurrence of a series that is not a row", async () => {
    await dailySeries();

    const first = await runReminders(NOW);
    const second = await runReminders(NOW);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(await messagesFor(EMAIL_A)).toHaveLength(1);
  });

  /**
   * The reason the ledger keys on `(series_id, occurs_on)` rather than on a row
   * id. The job reminds about a date nobody has touched; the user then opens it,
   * which materialises a row with a brand-new uuid. Keyed by the row, the next
   * run would see an unknown key and send a second email.
   */
  it("sends nothing more after the reminded occurrence is materialised", async () => {
    const series = await dailySeries();

    expect((await runReminders(NOW)).sent).toBe(1);

    // The user opens it and moves the slider — first touch, so a row appears.
    const materialised = await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: TODAY },
      { status: "in_progress", progressPct: 40 },
      "UTC",
    );
    expect(materialised).not.toBeNull();

    const after = await runReminders(NOW);

    expect(after.sent).toBe(0);
    expect(after.claimed).toBe(0);
    expect(await messagesFor(EMAIL_A)).toHaveLength(1);
  });
});

describe("criterion 22 — nothing is sent for a finished occurrence", () => {
  it("skips a stored task already marked done", async () => {
    await oneOff({ status: "done" });

    const summary = await runReminders(NOW);

    expect(summary.sent).toBe(0);
    expect(await messagesFor(EMAIL_A)).toHaveLength(0);
  });

  it("skips an occurrence of a series that was materialised as done", async () => {
    const series = await dailySeries();
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series.id, occursOn: TODAY },
      { status: "done" },
      "UTC",
    );

    const summary = await runReminders(NOW);

    expect(summary.sent).toBe(0);
    expect(await messagesFor(EMAIL_A)).toHaveLength(0);
  });
});

/**
 * ===========================================================================
 * THE GUARANTEE THE PHASE WAS DESIGNED AROUND
 * ===========================================================================
 *
 * `docs/gsd/devtask-pro-v1.md` originally had the job materialise occurrences
 * inside its horizon. Phase 3 shipped criteria 15 and 17 on the opposite
 * premise — untouched occurrences vanish on a rule edit or a delete *because
 * they were never rows*. These are the assertions that keep the amended
 * decision honest.
 */
describe("the job writes nothing to task_occurrence", () => {
  it("leaves the table byte-identical over a series with due reminders", async () => {
    await dailySeries();
    // One touched row, so the snapshot is not trivially empty on both sides.
    const series = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.userId, userA));
    await feed.materializeOccurrence(
      claimsA,
      { kind: "virtual", seriesId: series[0].id, occursOn: "2026-04-20" },
      { progressPct: 25 },
      "UTC",
    );

    const before = await occurrenceSnapshot();
    const summary = await runReminders(NOW);
    const after = await occurrenceSnapshot();

    // The run really did work — otherwise this would pass with nothing to do.
    expect(summary.sent).toBe(1);
    expect(before).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it("criterion 15 still holds after a run — a rule edit moves untouched dates", async () => {
    const series = await dailySeries();
    expect((await runReminders(NOW)).sent).toBe(1);

    // Move the series to Mondays only. 15 April 2026 is a Wednesday, so the
    // reminded date is no longer named. If the job had materialised it, the row
    // would survive the edit and still appear on that day.
    await seriesRepo.update(claimsA, series.id, {
      title: "Team standup",
      startsOn: TODAY,
      deadlineTime: "12:10",
      reminderLeadMinutes: LEAD,
      rule: normaliseRule({
        freq: "weekly",
        interval: 1,
        byweekday: ["MO"],
        monthMode: null,
        monthDay: null,
        nthWeek: null,
        nthWeekday: null,
        endsMode: "never",
        endsOn: null,
        endsCount: null,
      }),
    });

    const day = await feed.listDayFeed(claimsA, TODAY, "UTC");

    expect(day).toHaveLength(0);
    expect(await occurrenceSnapshot()).toHaveLength(0);
  });

  it("criterion 17 still holds after a run — deleting the series clears the future", async () => {
    const series = await dailySeries();
    expect((await runReminders(NOW)).sent).toBe(1);

    await seriesRepo.softDelete(claimsA, series.id);

    const day = await feed.listDayFeed(claimsA, TODAY, "UTC");

    expect(day).toHaveLength(0);
    expect(await occurrenceSnapshot()).toHaveLength(0);
  });
});

describe("what the job declines to send", () => {
  it("skips a reminder whose deadline has already passed, and says so", async () => {
    await oneOff();

    // An hour after the deadline — the job was down, or the cadence is slower
    // than the lead. Sending now would be worse than silence.
    const late = new Date(DEADLINE.getTime() + 60 * 60_000);
    const summary = await runReminders(late);

    expect(summary.sent).toBe(0);
    expect(summary.skippedLate).toBe(1);
    expect(await messagesFor(EMAIL_A)).toHaveLength(0);
  });

  it("sends nothing before the lead is reached", async () => {
    await oneOff();

    const early = new Date(DEADLINE.getTime() - (LEAD + 5) * 60_000);
    const summary = await runReminders(early);

    expect(summary.sent).toBe(0);
    expect(summary.skippedLate).toBe(0);
  });

  it("never reminds about a task with no deadline, however old", async () => {
    await oneOff({ deadlineAt: null });

    expect((await runReminders(NOW)).sent).toBe(0);
  });

  it("never reminds about a task with no lead set", async () => {
    await oneOff({ reminderLeadMinutes: null });

    expect((await runReminders(NOW)).sent).toBe(0);
  });

  it("skips a suspended account entirely", async () => {
    await oneOff();
    await dbAdmin
      .update(profiles)
      .set({ status: "suspended" })
      .where(eq(profiles.id, userA));

    const summary = await runReminders(NOW);

    expect(summary.sent).toBe(0);
    expect(await messagesFor(EMAIL_A)).toHaveLength(0);

    await activate(userA);
  });
});

describe("the ledger is the caller's own", () => {
  it("records the deadline it counted back from", async () => {
    const task = await oneOff();
    await runReminders(NOW);

    const [row] = await dbAdmin
      .select()
      .from(reminderLog)
      .where(eq(reminderLog.userId, userA));

    expect(row.occurrenceId).toBe(task.id);
    expect(row.seriesId).toBeNull();
    expect(row.occursOn).toBe(TODAY);
    expect(row.deadlineAt.toISOString()).toBe(DEADLINE.toISOString());
  });

  it("is readable through the scoped path by its owner and nobody else", async () => {
    await dailySeries();
    await runReminders(NOW);

    const [series] = await dbAdmin
      .select()
      .from(taskSeries)
      .where(eq(taskSeries.userId, userA));

    const mine = await remindersRepo.listForSeries(claimsA, series.id);
    const theirs = await remindersRepo.listForSeries(
      { sub: userB, email: EMAIL_B },
      series.id,
    );

    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
  });
});

describe("the message that actually arrives", () => {
  it("is addressed to the account holder and names the task", async () => {
    await oneOff();
    await runReminders(NOW);

    const [message] = await messagesFor(EMAIL_A);

    expect(message.Subject).toBe("Ship the migration — due in 30 minutes");
  });
});
