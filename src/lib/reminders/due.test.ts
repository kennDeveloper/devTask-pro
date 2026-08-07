import { describe, expect, it } from "vitest";

import { reminderKeyToken } from "@/lib/db/repos/reminders";
import { fromSeries, occurrenceDeadline } from "@/lib/tasks/feed";

import { dueReminders, fireAt, reminderKeyFor } from "./due";

import type { TaskSeries } from "@/lib/db/schema";
import type { ListedOccurrence } from "@/lib/tasks/feed";

const SERIES_ID = "22222222-2222-4222-8222-222222222222";
const OCCURRENCE_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A stored one-off, the simplest thing that can remind. */
function row(overrides: Partial<ListedOccurrence> = {}): ListedOccurrence {
  return {
    id: OCCURRENCE_ID,
    seriesId: null,
    title: "Ship the migration",
    description: null,
    occursOn: "2026-08-07",
    deadlineAt: new Date("2026-08-07T09:00:00.000Z"),
    status: "todo",
    progressPct: 0,
    reminderLeadMinutes: 30,
    completedAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    virtual: false,
    tags: [],
    ...overrides,
  };
}

function makeSeries(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: SERIES_ID,
    userId: USER_ID,
    title: "Team standup",
    description: null,
    freq: "daily",
    interval: 1,
    // Empty on anything but a weekly rule — `task_series_weekly_days_check`.
    byweekday: [],
    monthMode: null,
    monthDay: null,
    nthWeek: null,
    nthWeekday: null,
    startsOn: "2026-01-05",
    deadlineTime: "09:00:00",
    endsMode: "never",
    endsOn: null,
    endsCount: null,
    rrule: "FREQ=DAILY",
    reminderLeadMinutes: 30,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
    ...overrides,
  };
}

const DEADLINE = new Date("2026-08-07T09:00:00.000Z");
/** 30 minutes before `DEADLINE`. */
const FIRE = new Date("2026-08-07T08:30:00.000Z");

describe("fireAt", () => {
  it("counts the lead back from the deadline", () => {
    expect(fireAt(row())?.toISOString()).toBe(FIRE.toISOString());
  });

  it("is the deadline itself at a zero lead", () => {
    expect(fireAt(row({ reminderLeadMinutes: 0 }))?.toISOString()).toBe(
      DEADLINE.toISOString(),
    );
  });

  it("is null with no lead set — the off switch", () => {
    expect(fireAt(row({ reminderLeadMinutes: null }))).toBeNull();
  });

  it("is null with no deadline, however old — criterion 8 inherited", () => {
    expect(fireAt(row({ deadlineAt: null }))).toBeNull();
  });
});

describe("reminderKeyFor", () => {
  it("keys a one-off by its row id", () => {
    expect(reminderKeyFor(row())).toEqual({
      kind: "occurrence",
      occurrenceId: OCCURRENCE_ID,
      occursOn: "2026-08-07",
    });
  });

  it("keys a projected series occurrence by (series, date)", () => {
    const projected = fromSeries(makeSeries(), "2026-08-07", "UTC");

    expect(reminderKeyFor(projected)).toEqual({
      kind: "series",
      seriesId: SERIES_ID,
      occursOn: "2026-08-07",
    });
  });

  /**
   * The whole reason the ledger keys on identity rather than on a row id. The
   * job reminds on a date nobody has touched; the user then touches it, which
   * materialises a row with a real uuid. If the key changed with it, the next
   * run would see an unknown key and send a second email.
   */
  it("gives a series date the same key before and after materialisation", () => {
    const projected = fromSeries(makeSeries(), "2026-08-07", "UTC");
    const materialised = row({
      id: OCCURRENCE_ID,
      seriesId: SERIES_ID,
      occursOn: "2026-08-07",
      virtual: false,
    });

    expect(reminderKeyToken(reminderKeyFor(projected)!)).toBe(
      reminderKeyToken(reminderKeyFor(materialised)!),
    );
  });
});

describe("dueReminders — the send window", () => {
  it("sends nothing before the lead is reached", () => {
    const at = new Date(FIRE.getTime() - 1);

    expect(dueReminders([row()], at).due).toHaveLength(0);
  });

  it("sends exactly at the lead — the left bound is inclusive", () => {
    const { due } = dueReminders([row()], FIRE);

    expect(due).toHaveLength(1);
    expect(due[0].fireAt.toISOString()).toBe(FIRE.toISOString());
    expect(due[0].deadlineAt.toISOString()).toBe(DEADLINE.toISOString());
  });

  it("still sends one millisecond before the deadline", () => {
    const at = new Date(DEADLINE.getTime() - 1);

    expect(dueReminders([row()], at).due).toHaveLength(1);
  });

  it("skips exactly at the deadline — the right bound is exclusive", () => {
    const selection = dueReminders([row()], DEADLINE);

    expect(selection.due).toHaveLength(0);
    expect(selection.skippedLate).toBe(1);
  });

  it("skips a reminder whose moment passed while the job was down", () => {
    // Three days late. The task is already in the Overdue bucket saying so;
    // "due in 30 minutes" would be worse than silence.
    const at = new Date(DEADLINE.getTime() + 3 * 24 * 60 * 60_000);
    const selection = dueReminders([row()], at);

    expect(selection.due).toHaveLength(0);
    expect(selection.skippedLate).toBe(1);
  });
});

describe("dueReminders — what never reminds", () => {
  it("skips a done task — criterion 22", () => {
    expect(dueReminders([row({ status: "done" })], FIRE).due).toHaveLength(0);
  });

  it("counts a done task as skipped rather than late", () => {
    // It was not missed; it was finished. Reporting it as a missed reminder
    // would make the run summary read like an outage.
    const at = new Date(DEADLINE.getTime() + 60_000);

    expect(dueReminders([row({ status: "done" })], at).skippedLate).toBe(0);
  });

  it("skips a task with no lead, at any distance from its deadline", () => {
    expect(
      dueReminders([row({ reminderLeadMinutes: null })], FIRE).due,
    ).toHaveLength(0);
  });

  it("skips a task with no deadline, however old", () => {
    expect(
      dueReminders([row({ deadlineAt: null, occursOn: "2020-01-01" })], FIRE)
        .due,
    ).toHaveLength(0);
  });

  it("skips one already in the ledger, and does not call it late", () => {
    const already = new Set([
      reminderKeyToken({
        kind: "occurrence",
        occurrenceId: OCCURRENCE_ID,
        occursOn: "2026-08-07",
      }),
    ]);
    const past = new Date(DEADLINE.getTime() + 60_000);
    const selection = dueReminders([row()], past, already);

    expect(selection.due).toHaveLength(0);
    expect(selection.skippedLate).toBe(0);
  });
});

describe("dueReminders — projections remind without becoming rows", () => {
  it("sends for an occurrence nobody has touched", () => {
    // The point of the whole design: no row exists for this date and none is
    // created, so criteria 15 and 17 are untouched by the job having run.
    const projected = fromSeries(makeSeries(), "2026-08-07", "UTC");
    const { due } = dueReminders([projected], FIRE);

    expect(due).toHaveLength(1);
    expect(due[0].occurrence.virtual).toBe(true);
    expect(due[0].key).toEqual({
      kind: "series",
      seriesId: SERIES_ID,
      occursOn: "2026-08-07",
    });
  });

  it("inherits the series' lead, so a template reminder reaches every date", () => {
    const projected = fromSeries(
      makeSeries({ reminderLeadMinutes: 60 }),
      "2026-08-07",
      "UTC",
    );

    expect(fireAt(projected)?.toISOString()).toBe("2026-08-07T08:00:00.000Z");
  });

  it("never sends for a series with no deadline time", () => {
    const projected = fromSeries(
      makeSeries({ deadlineTime: null }),
      "2026-08-07",
      "UTC",
    );

    expect(dueReminders([projected], FIRE).due).toHaveLength(0);
  });
});

/**
 * CRITERION 9 — the local hour is the one the account holder set, on both sides
 * of a DST transition.
 *
 * The reminder counts back from `occurrenceDeadline`, which resolves the series'
 * wall clock per date in the owner's zone (criterion 20). So this is really an
 * assertion that phase 6 reuses that function rather than deriving an instant of
 * its own — a stored instant plus a fixed 24-hour multiple would drift by an
 * hour for half the year.
 */
describe("dueReminders — the local hour survives a DST transition", () => {
  const series = makeSeries({ deadlineTime: "09:00:00", reminderLeadMinutes: 30 });

  it("fires 08:30 local in a zone with no DST at all", () => {
    // Manila is UTC+8 year round: 08:30 local is 00:30Z on any date.
    for (const day of ["2026-03-07", "2026-07-07", "2026-11-07"]) {
      const deadline = occurrenceDeadline(series, day, "Asia/Manila")!;
      const projected = fromSeries(series, day, "Asia/Manila");

      expect(fireAt(projected)!.getTime()).toBe(deadline.getTime() - 30 * 60_000);
      expect(fireAt(projected)!.toISOString()).toBe(`${day}T00:30:00.000Z`);
    }
  });

  it("fires 08:30 local either side of the US spring-forward", () => {
    // 2026-03-08 is the transition. Before it New York is UTC-5, after UTC-4,
    // so the same 08:30 wall clock is a different instant — which is the point.
    const before = fromSeries(series, "2026-03-07", "America/New_York");
    const after = fromSeries(series, "2026-03-09", "America/New_York");

    expect(fireAt(before)!.toISOString()).toBe("2026-03-07T13:30:00.000Z");
    expect(fireAt(after)!.toISOString()).toBe("2026-03-09T12:30:00.000Z");
  });

  it("is due at that local instant and not an hour either side of it", () => {
    const after = fromSeries(series, "2026-03-09", "America/New_York");
    const localFire = new Date("2026-03-09T12:30:00.000Z");

    expect(dueReminders([after], new Date(localFire.getTime() - 1)).due).toHaveLength(0);
    expect(dueReminders([after], localFire).due).toHaveLength(1);
  });
});

describe("dueReminders — a whole feed at once", () => {
  it("keeps only what is due, and reports the rest honestly", () => {
    const selection = dueReminders(
      [
        row({ id: "a", status: "done" }),
        row({ id: "b", reminderLeadMinutes: null }),
        row({ id: "c" }),
        row({ id: "d", deadlineAt: new Date(FIRE.getTime() - 60_000) }),
      ],
      FIRE,
    );

    expect(selection.due.map((entry) => entry.occurrence.id)).toEqual(["c"]);
    expect(selection.skippedLate).toBe(1);
  });
});
