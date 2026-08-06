import { describe, expect, it } from "vitest";

import {
  dayLabel,
  formatCalendarDate,
  formatDeadline,
  instantToLocalInput,
  localInputToInstant,
  taskColumns,
} from "./task-presentation";

/**
 * These are the assertions that keep the two clock-related acceptance criteria
 * honest at the presentation layer: every string is produced from an *argument*
 * — an instant, a zone, a day — and never from the host's own clock or locale.
 * A formatter that read either would pass a test written against the machine it
 * was written on and fail in the browser of the user it was written for.
 */

describe("taskColumns", () => {
  it("drops the Day column when the list is already one day", () => {
    expect(taskColumns(false).map((column) => column.key)).toEqual([
      "task",
      "deadline",
      "status",
      "progress",
      "actions",
    ]);
  });

  it("keeps it for lists that span days", () => {
    expect(taskColumns(true).map((column) => column.key)).toContain("day");
  });
});

describe("formatCalendarDate", () => {
  it("renders a bare calendar date without letting a zone move it", () => {
    // 00:00 on the 6th in UTC is still the 5th in New York. Formatting the
    // square through a zone is exactly how an `occurs_on` slips a day.
    expect(formatCalendarDate("2026-08-06")).toBe("6 Aug 2026");
  });

  it("passes through anything that is not a calendar date", () => {
    expect(formatCalendarDate("not-a-date")).toBe("not-a-date");
  });
});

describe("dayLabel", () => {
  const today = "2026-08-06";

  it("names the days around today rather than dating them", () => {
    expect(dayLabel("2026-08-06", today)).toBe("Today");
    expect(dayLabel("2026-08-07", today)).toBe("Tomorrow");
    expect(dayLabel("2026-08-05", today)).toBe("Yesterday");
  });

  it("dates anything further out", () => {
    expect(dayLabel("2026-08-09", today)).toBe("9 Aug 2026");
  });

  it("crosses a month boundary without arithmetic of its own", () => {
    expect(dayLabel("2026-09-01", "2026-08-31")).toBe("Tomorrow");
  });
});

describe("formatDeadline", () => {
  const instant = "2026-08-06T15:00:00.000Z";

  it("renders the instant in the account holder's zone, not the host's", () => {
    expect(formatDeadline(instant, "Asia/Manila")).toBe("6 Aug 2026, 23:00");
    expect(formatDeadline(instant, "UTC")).toBe("6 Aug 2026, 15:00");
  });

  it("falls back rather than throwing on a zone the runtime rejects", () => {
    // A zone can rot between the day it was saved and the day it is read. A
    // deadline shown in UTC is wrong by hours; a thrown error is a blank list.
    expect(formatDeadline(instant, "Mars/Olympus_Mons")).toBe(
      "6 Aug 2026, 15:00",
    );
  });
});

describe("instantToLocalInput / localInputToInstant", () => {
  it("shows a deadline on the clock the user set it on", () => {
    expect(instantToLocalInput("2026-08-06T15:00:00.000Z", "Asia/Manila")).toBe(
      "2026-08-06T23:00",
    );
  });

  it("reads a typed wall clock as an instant in that same zone", () => {
    expect(localInputToInstant("2026-08-06T23:00", "Asia/Manila")).toBe(
      "2026-08-06T15:00:00.000Z",
    );
  });

  it("round-trips through a zone that observes DST, on both sides of it", () => {
    for (const local of ["2026-01-15T09:30", "2026-07-15T09:30"]) {
      const instant = localInputToInstant(local, "America/New_York");
      expect(instant).not.toBeNull();
      expect(instantToLocalInput(instant!, "America/New_York")).toBe(local);
    }
  });

  it("resolves the offset at the instant, not at the date", () => {
    // The trap `startOfDayInZone` documents at length: New York is −05:00 in
    // January and −04:00 in July, so a fixed offset is wrong half the year.
    expect(localInputToInstant("2026-01-15T12:00", "America/New_York")).toBe(
      "2026-01-15T17:00:00.000Z",
    );
    expect(localInputToInstant("2026-07-15T12:00", "America/New_York")).toBe(
      "2026-07-15T16:00:00.000Z",
    );
  });

  it("reports a value that is not a wall clock rather than inventing one", () => {
    expect(localInputToInstant("", "UTC")).toBeNull();
    expect(localInputToInstant("2026-08-06", "UTC")).toBeNull();
  });

  it("returns an empty control value for an unparseable stored deadline", () => {
    expect(instantToLocalInput("nonsense", "UTC")).toBe("");
  });
});
