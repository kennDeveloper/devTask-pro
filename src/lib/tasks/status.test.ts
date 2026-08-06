import { describe, expect, it } from "vitest";

import { TASK_STATUSES } from "@/lib/db/schema";

import {
  TASK_STATUS_LABELS,
  TASK_STATUS_OPTIONS,
  isDone,
  isTaskStatus,
  nextStatus,
  taskStatusLabel,
} from "./status";

describe("labels", () => {
  it("has a label for every status the constraint allows", () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(TASK_STATUS_LABELS)).toHaveLength(TASK_STATUSES.length);
  });

  it("passes an unrecognised status through rather than rendering undefined", () => {
    expect(taskStatusLabel("in_progress")).toBe("In progress");
    expect(taskStatusLabel("blocked")).toBe("blocked");
  });

  it("offers every status to the control, in workflow order", () => {
    expect(TASK_STATUS_OPTIONS.map((option) => option.value)).toEqual([
      ...TASK_STATUSES,
    ]);
    expect(TASK_STATUS_OPTIONS.map((option) => option.label)).toEqual([
      "To do",
      "In progress",
      "Done",
    ]);
  });
});

describe("isTaskStatus", () => {
  it("accepts exactly the three stored values", () => {
    for (const status of TASK_STATUSES) {
      expect(isTaskStatus(status)).toBe(true);
    }
  });

  it("rejects labels, near-misses and non-strings", () => {
    expect(isTaskStatus("In progress")).toBe(false);
    expect(isTaskStatus("inprogress")).toBe(false);
    expect(isTaskStatus(null)).toBe(false);
    expect(isTaskStatus(undefined)).toBe(false);
    expect(isTaskStatus(0)).toBe(false);
  });
});

describe("isDone", () => {
  it("is true only for done", () => {
    expect(isDone("done")).toBe(true);
    expect(isDone("todo")).toBe(false);
    expect(isDone("in_progress")).toBe(false);
  });
});

describe("nextStatus", () => {
  it("advances through the workflow", () => {
    expect(nextStatus("todo")).toBe("in_progress");
    expect(nextStatus("in_progress")).toBe("done");
  });

  /**
   * The guard against someone "tidying" this into a one-way flow. Status is
   * freely reversible — reopening a task that turned out not to be finished is
   * a normal thing to do — so `done` is not a terminal state and the cycle
   * wraps rather than sticking.
   */
  it("wraps at done, so nothing is a dead end", () => {
    expect(nextStatus("done")).toBe("todo");
  });

  it("returns to where it started after one full cycle", () => {
    const start = "todo" as const;
    expect(nextStatus(nextStatus(nextStatus(start)))).toBe(start);
  });
});
