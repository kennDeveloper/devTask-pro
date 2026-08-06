import { describe, expect, it } from "vitest";

import { isOverdue, type OverdueTaskFields } from "./overdue";

import type { TaskStatus } from "@/lib/db/schema";

/**
 * A fixed instant, so nothing here depends on when the suite runs. Every
 * fixture below is expressed relative to it.
 */
const NOW = new Date("2026-08-06T12:00:00.000Z");

const HOUR = 60 * 60 * 1000;
const YEAR = 365 * 24 * HOUR;

const iso = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

const task = (
  deadlineAt: OverdueTaskFields["deadlineAt"],
  status: TaskStatus,
): OverdueTaskFields => ({ deadlineAt, status });

describe("isOverdue — no deadline (criterion 8)", () => {
  /**
   * The criterion is about age, so the fixture is genuinely ancient. In SQL
   * this falls out of `NULL < now()` being NULL; JavaScript has no NULL, so
   * the null case is the first thing the function checks and the first thing
   * asserted here.
   */
  it("is never overdue, however old the task is", () => {
    for (const status of ["todo", "in_progress", "done"] as const) {
      expect(isOverdue(task(null, status), NOW)).toBe(false);
    }

    const ancient = new Date(NOW.getTime() + 5 * YEAR);
    expect(isOverdue(task(null, "todo"), ancient)).toBe(false);
  });
});

describe("isOverdue — past deadline (criteria 9 and 10)", () => {
  it("is overdue while the task is unfinished", () => {
    expect(isOverdue(task(iso(-HOUR), "todo"), NOW)).toBe(true);
    expect(isOverdue(task(iso(-HOUR), "in_progress"), NOW)).toBe(true);
  });

  /**
   * Criterion 10. Nothing is stored and nothing is invalidated — the same row,
   * the same deadline, the same `now`, only the status differs, and it drops
   * out of the bucket on the next render.
   */
  it("is not overdue once the task is done", () => {
    expect(isOverdue(task(iso(-HOUR), "done"), NOW)).toBe(false);
    expect(isOverdue(task(iso(-5 * YEAR), "done"), NOW)).toBe(false);
  });
});

describe("isOverdue — future deadline (criterion 11)", () => {
  it("is not overdue once the deadline moves into the future", () => {
    const wasOverdue = task(iso(-HOUR), "todo");
    expect(isOverdue(wasOverdue, NOW)).toBe(true);

    const rescheduled = task(iso(+HOUR), "todo");
    expect(isOverdue(rescheduled, NOW)).toBe(false);
  });

  /**
   * Criterion 18 in miniature: a deadline of 23:00 in Asia/Manila is
   * 15:00Z, and at 14:00Z — 22:00 local — it is not yet late. No timezone
   * maths is involved, which is the point: `deadline_at` is an instant, so the
   * comparison is absolute whatever zone either side is thinking in.
   */
  it("compares absolute instants, not local wall clocks", () => {
    const dueElevenPmManila = new Date("2026-08-06T15:00:00.000Z");
    const tenPmManila = new Date("2026-08-06T14:00:00.000Z");
    const midnightManila = new Date("2026-08-06T16:00:00.000Z");

    expect(isOverdue(task(dueElevenPmManila, "todo"), tenPmManila)).toBe(false);
    expect(isOverdue(task(dueElevenPmManila, "todo"), midnightManila)).toBe(
      true,
    );
  });
});

describe("isOverdue — input shapes", () => {
  /**
   * The link has no transformer, so the client receives `deadlineAt` as an ISO
   * string while the server holds a `Date`. Both are the same question and
   * must produce the same answer, or /overdue disagrees with itself across the
   * SSR boundary.
   */
  it("treats a Date and its ISO string identically", () => {
    const deadline = new Date(NOW.getTime() - HOUR);
    expect(isOverdue(task(deadline, "todo"), NOW)).toBe(
      isOverdue(task(deadline.toISOString(), "todo"), NOW),
    );
  });

  it("is exclusive at the boundary — a deadline of exactly now is not yet late", () => {
    expect(isOverdue(task(NOW, "todo"), NOW)).toBe(false);
    expect(isOverdue(task(new Date(NOW.getTime() - 1), "todo"), NOW)).toBe(true);
  });

  /** NaN comparisons are false, so an unreadable value never nags the user. */
  it("reports an unparseable deadline as not overdue rather than throwing", () => {
    expect(isOverdue(task("not a date", "todo"), NOW)).toBe(false);
  });
});
