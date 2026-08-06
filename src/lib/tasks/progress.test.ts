import { describe, expect, it } from "vitest";

import {
  PROGRESS_MAX,
  PROGRESS_MIN,
  clampProgress,
  formatProgress,
  isValidProgress,
} from "./progress";

describe("bounds", () => {
  it("mirrors the column's CHECK", () => {
    expect(PROGRESS_MIN).toBe(0);
    expect(PROGRESS_MAX).toBe(100);
  });
});

describe("isValidProgress", () => {
  it("accepts both ends inclusively (criterion 12)", () => {
    expect(isValidProgress(PROGRESS_MIN)).toBe(true);
    expect(isValidProgress(PROGRESS_MAX)).toBe(true);
    expect(isValidProgress(40)).toBe(true);
  });

  it("rejects one step past either end", () => {
    expect(isValidProgress(-1)).toBe(false);
    expect(isValidProgress(101)).toBe(false);
  });

  it("rejects non-integers, since the column is an integer", () => {
    expect(isValidProgress(42.5)).toBe(false);
    expect(isValidProgress(Number.NaN)).toBe(false);
    expect(isValidProgress(Number.POSITIVE_INFINITY)).toBe(false);
  });

  it("rejects values that merely look numeric", () => {
    expect(isValidProgress("40")).toBe(false);
    expect(isValidProgress(null)).toBe(false);
    expect(isValidProgress(undefined)).toBe(false);
  });
});

describe("clampProgress", () => {
  it("leaves an in-range value alone", () => {
    expect(clampProgress(40)).toBe(40);
    expect(clampProgress(PROGRESS_MIN)).toBe(PROGRESS_MIN);
    expect(clampProgress(PROGRESS_MAX)).toBe(PROGRESS_MAX);
  });

  it("pulls an out-of-range value to the nearest end", () => {
    expect(clampProgress(-20)).toBe(PROGRESS_MIN);
    expect(clampProgress(1000)).toBe(PROGRESS_MAX);
  });

  it("rounds, and turns NaN into a renderable number", () => {
    expect(clampProgress(42.4)).toBe(42);
    expect(clampProgress(42.5)).toBe(43);
    expect(clampProgress(Number.NaN)).toBe(PROGRESS_MIN);
  });
});

describe("formatProgress", () => {
  it("is the single spelling of the readout", () => {
    expect(formatProgress(0)).toBe("0%");
    expect(formatProgress(40)).toBe("40%");
    expect(formatProgress(100)).toBe("100%");
  });
});

/**
 * The guard on criterion 12's real subject. These do not assert behaviour so
 * much as the *absence* of behaviour — there is no helper that reconciles the
 * two values, and this module cannot grow one without first importing the
 * status module it deliberately does not import.
 */
describe("progress is independent of status", () => {
  it("does not coerce a done task's progress to 100", () => {
    // What the UI holds for a task marked done at 40%: two facts, both kept.
    const done = { status: "done" as const, progressPct: 40 };
    expect(isValidProgress(done.progressPct)).toBe(true);
    expect(clampProgress(done.progressPct)).toBe(40);
    expect(formatProgress(done.progressPct)).toBe("40%");
  });

  it("does not treat 100% as finished", () => {
    const stillGoing = { status: "in_progress" as const, progressPct: 100 };
    expect(isValidProgress(stillGoing.progressPct)).toBe(true);
    expect(stillGoing.status).toBe("in_progress");
  });
});
