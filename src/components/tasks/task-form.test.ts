import { describe, expect, it } from "vitest";

import { TASK_MESSAGES, TITLE_MAX_LENGTH } from "@/lib/tasks/validators";

import {
  buildCreateInput,
  buildUpdatePatch,
  initialTaskFormValues,
  type TaskFormValues,
} from "./task-form";

import type { Task, TaskClock } from "./types";

const CLOCK: TaskClock = {
  now: new Date("2026-08-06T15:00:00.000Z"),
  timeZone: "Asia/Manila",
  today: "2026-08-06",
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    seriesId: null,
    virtual: false,
    tags: [],
    title: "Write the migration",
    description: null,
    occursOn: "2026-08-06",
    deadlineAt: null,
    status: "todo",
    progressPct: 0,
    reminderLeadMinutes: null,
    completedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function values(overrides: Partial<TaskFormValues> = {}): TaskFormValues {
  return {
    title: "Write the migration",
    description: "",
    occursOn: "2026-08-06",
    deadlineLocal: "",
    status: "todo",
    progressPct: 0,
    reminderLeadMinutes: null,
    ...overrides,
  };
}

describe("initialTaskFormValues", () => {
  it("seeds a new task with the user's day, never the browser's", () => {
    expect(initialTaskFormValues(null, CLOCK)).toEqual({
      title: "",
      description: "",
      occursOn: "2026-08-06",
      deadlineLocal: "",
      status: "todo",
      progressPct: 0,
      // Off by default — a task reminds only because somebody asked it to.
      reminderLeadMinutes: null,
    });
  });

  it("shows an existing deadline on the clock it was set on", () => {
    const seeded = initialTaskFormValues(
      task({ deadlineAt: "2026-08-06T15:00:00.000Z" }),
      CLOCK,
    );
    // 15:00 UTC is 23:00 in Manila. Seeding through `new Date(...)` and the
    // browser's zone would show whatever the *device* thinks, which is a
    // different number on a laptop that has crossed a border.
    expect(seeded.deadlineLocal).toBe("2026-08-06T23:00");
  });

  it("turns a null description into the empty string a <textarea> holds", () => {
    expect(initialTaskFormValues(task(), CLOCK).description).toBe("");
  });
});

describe("buildCreateInput", () => {
  it("builds the payload the router validates", () => {
    const result = buildCreateInput(
      values({ title: "  Ship it  ", deadlineLocal: "2026-08-06T23:00" }),
      CLOCK.timeZone,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.title).toBe("Ship it");
    expect(result.data.occursOn).toBe("2026-08-06");
    expect(result.data.deadlineAt).toEqual(new Date("2026-08-06T15:00:00.000Z"));
  });

  it("stores an empty notes field as null, not as an empty string", () => {
    // Two spellings of "no notes" would make every later `is null` check wrong.
    const result = buildCreateInput(values({ description: "" }), CLOCK.timeZone);
    expect(result.ok && result.data.description).toBeNull();
  });

  it("reports the same sentence the server would have", () => {
    const result = buildCreateInput(values({ title: "   " }), CLOCK.timeZone);
    expect(result).toEqual({
      ok: false,
      errors: { title: TASK_MESSAGES.titleRequired },
    });
  });

  it("catches an over-long title before the round trip", () => {
    const result = buildCreateInput(
      values({ title: "x".repeat(TITLE_MAX_LENGTH + 1) }),
      CLOCK.timeZone,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.title).toBe(TASK_MESSAGES.titleTooLong);
  });

  it("blames the deadline field for an unreadable deadline", () => {
    const result = buildCreateInput(
      values({ deadlineLocal: "tomorrow-ish" }),
      CLOCK.timeZone,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.deadlineLocal).toBe(TASK_MESSAGES.deadlineInvalid);
  });
});

describe("buildUpdatePatch", () => {
  const existing = task();

  it("sends only the field that changed", () => {
    const result = buildUpdatePatch(
      values({ title: "Write the rollback too" }),
      existing,
      CLOCK.timeZone,
    );

    // Not a replacement: a dialog opened at 09:00 and submitted at 09:05 must
    // not write back the status a row control changed in between.
    expect(result).toEqual({
      ok: true,
      data: { id: existing.id, title: "Write the rollback too" },
    });
  });

  it("sends nothing at all when the form was not touched", () => {
    const result = buildUpdatePatch(values(), existing, CLOCK.timeZone);
    expect(result).toEqual({ ok: true, data: null });
  });

  it("clears a deadline with an explicit null rather than by omission", () => {
    const result = buildUpdatePatch(
      values(),
      task({ deadlineAt: "2026-08-06T15:00:00.000Z" }),
      CLOCK.timeZone,
    );
    expect(result).toEqual({
      ok: true,
      data: { id: existing.id, deadlineAt: null },
    });
  });

  it("leaves an unchanged deadline out, comparing instants and not spellings", () => {
    const result = buildUpdatePatch(
      values({ deadlineLocal: "2026-08-06T23:00" }),
      task({ deadlineAt: "2026-08-06T15:00:00.000Z" }),
      CLOCK.timeZone,
    );
    expect(result).toEqual({ ok: true, data: null });
  });

  /**
   * Criterion 12, at the payload layer. Neither value may be derived from the
   * other in either direction, so each of these patches names exactly one field.
   */
  it("does not touch progress when the status moves to done", () => {
    const result = buildUpdatePatch(
      values({ status: "done", progressPct: 40 }),
      task({ status: "todo", progressPct: 40 }),
      CLOCK.timeZone,
    );
    expect(result).toEqual({ ok: true, data: { id: existing.id, status: "done" } });
  });

  it("does not touch status when a done task's progress is dragged to 40", () => {
    const result = buildUpdatePatch(
      values({ status: "done", progressPct: 40 }),
      task({ status: "done", progressPct: 100 }),
      CLOCK.timeZone,
    );
    expect(result).toEqual({
      ok: true,
      data: { id: existing.id, progressPct: 40 },
    });
  });

  it("refuses an invalid edit with the field named", () => {
    const result = buildUpdatePatch(
      values({ title: "" }),
      existing,
      CLOCK.timeZone,
    );
    expect(result).toEqual({
      ok: false,
      errors: { title: TASK_MESSAGES.titleRequired },
    });
  });
});

describe("the reminder lead", () => {
  const TASK_ID = task().id;

  it("seeds from the task, including a series' template lead on a projection", () => {
    // A projected occurrence carries its series' value, so the editor shows what
    // it would actually remind at rather than an empty control.
    const seeded = initialTaskFormValues(
      task({ reminderLeadMinutes: 60, seriesId: "s", virtual: true }),
      CLOCK,
    );

    expect(seeded.reminderLeadMinutes).toBe(60);
  });

  it("sends a newly chosen lead on create", () => {
    const result = buildCreateInput(
      values({ deadlineLocal: "2026-08-06T23:00", reminderLeadMinutes: 30 }),
      CLOCK.timeZone,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.reminderLeadMinutes).toBe(30);
  });

  it("patches only when it actually moved", () => {
    const unchanged = buildUpdatePatch(
      values({ deadlineLocal: "2026-08-06T23:00", reminderLeadMinutes: 30 }),
      task({ deadlineAt: "2026-08-06T15:00:00.000Z", reminderLeadMinutes: 30 }),
      CLOCK.timeZone,
    );

    expect(unchanged.ok && unchanged.data).toBeNull();
  });

  it("sends null when the user switches the reminder off", () => {
    // `null` is a real value, not an absence — a truthiness check here would
    // make "no reminder" unsendable and silently leave the old lead in place.
    const result = buildUpdatePatch(
      values({ deadlineLocal: "2026-08-06T23:00", reminderLeadMinutes: null }),
      task({ deadlineAt: "2026-08-06T15:00:00.000Z", reminderLeadMinutes: 30 }),
      CLOCK.timeZone,
    );

    // The deadline is unchanged — 23:00 Manila *is* 15:00Z — so it is correctly
    // left out and the patch names only what the user actually moved.
    expect(result.ok && result.data).toEqual({
      id: TASK_ID,
      reminderLeadMinutes: null,
    });
  });

  /**
   * Clearing the deadline takes the reminder with it. A lead with nothing to
   * count back from would sit in the database looking set while `dueReminders`
   * ignored it — a reminder the user believes they have and never receives.
   */
  it("clears the lead when the deadline is cleared in the same submit", () => {
    const result = buildUpdatePatch(
      values({ deadlineLocal: "", reminderLeadMinutes: 30 }),
      task({ deadlineAt: "2026-08-06T15:00:00.000Z", reminderLeadMinutes: 30 }),
      CLOCK.timeZone,
    );

    expect(result.ok && result.data).toEqual({
      id: TASK_ID,
      deadlineAt: null,
      reminderLeadMinutes: null,
    });
  });

  it("never sends a lead on a create with no deadline", () => {
    const result = buildCreateInput(
      values({ deadlineLocal: "", reminderLeadMinutes: 30 }),
      CLOCK.timeZone,
    );

    expect(result.ok && result.data.reminderLeadMinutes).toBeNull();
  });
});
