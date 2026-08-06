import { describe, expect, it } from "vitest";
import type { z } from "zod";

import {
  DESCRIPTION_MAX_LENGTH,
  TASK_MESSAGES,
  TITLE_MAX_LENGTH,
  isCalendarDate,
  taskInput,
  taskUpdateInput,
} from "./validators";

const ID = "3f1c2c4e-1b0a-4f2e-9c3d-5a6b7c8d9e0f";

/** The one field `taskInput` insists on, so each case can vary just its own. */
const withTitle = (rest: Record<string, unknown> = {}) => ({
  title: "Write the migration",
  ...rest,
});

/** First message only — a form shows one line under a control. */
const firstError = (result: z.ZodSafeParseResult<unknown>) =>
  result.success ? null : result.error.issues[0]?.message;

describe("isCalendarDate", () => {
  it("accepts a real day", () => {
    expect(isCalendarDate("2026-08-06")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // a leap day that exists
  });

  it("rejects a day that merely matches the pattern", () => {
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("2026-02-29")).toBe(false); // 2026 is not a leap year
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-00-10")).toBe(false);
  });

  it("rejects anything that is not a bare YYYY-MM-DD", () => {
    expect(isCalendarDate("2026-8-6")).toBe(false);
    expect(isCalendarDate("06/08/2026")).toBe(false);
    expect(isCalendarDate("2026-08-06T00:00:00Z")).toBe(false);
    expect(isCalendarDate("")).toBe(false);
  });
});

describe("title", () => {
  it("is trimmed before it is stored, matching length(btrim(title))", () => {
    const result = taskInput.safeParse({ title: "  Write the migration  " });
    expect(result.success && result.data.title).toBe("Write the migration");
  });

  it("rejects blank and whitespace-only titles with the same message", () => {
    expect(firstError(taskInput.safeParse({ title: "" }))).toBe(
      TASK_MESSAGES.titleRequired,
    );
    expect(firstError(taskInput.safeParse({ title: "   " }))).toBe(
      TASK_MESSAGES.titleRequired,
    );
    expect(firstError(taskInput.safeParse({}))).toBe(
      TASK_MESSAGES.titleRequired,
    );
  });

  it("accepts exactly the constraint's limit and rejects one past it", () => {
    expect(
      taskInput.safeParse({ title: "a".repeat(TITLE_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      firstError(
        taskInput.safeParse({ title: "a".repeat(TITLE_MAX_LENGTH + 1) }),
      ),
    ).toBe(TASK_MESSAGES.titleTooLong);
  });
});

describe("description", () => {
  it("distinguishes absent from cleared", () => {
    const absent = taskInput.safeParse(withTitle());
    expect(absent.success && absent.data.description).toBeUndefined();

    const cleared = taskInput.safeParse(withTitle({ description: null }));
    expect(cleared.success && cleared.data.description).toBeNull();
  });

  it("normalises an emptied textarea to null rather than an empty string", () => {
    const blank = taskInput.safeParse(withTitle({ description: "   " }));
    expect(blank.success && blank.data.description).toBeNull();
  });

  it("trims, and rejects one character past the constraint", () => {
    const kept = taskInput.safeParse(withTitle({ description: "  notes  " }));
    expect(kept.success && kept.data.description).toBe("notes");

    expect(
      taskInput.safeParse(
        withTitle({ description: "a".repeat(DESCRIPTION_MAX_LENGTH) }),
      ).success,
    ).toBe(true);
    expect(
      firstError(
        taskInput.safeParse({
          description: "a".repeat(DESCRIPTION_MAX_LENGTH + 1),
        }),
      ),
    ).toBe(TASK_MESSAGES.titleRequired);
    expect(
      firstError(
        taskInput.safeParse(
          withTitle({ description: "a".repeat(DESCRIPTION_MAX_LENGTH + 1) }),
        ),
      ),
    ).toBe(TASK_MESSAGES.descriptionTooLong);
  });
});

describe("occursOn", () => {
  /**
   * Absent is legitimate: the server fills it with today *in the caller's
   * timezone* (criterion 6). A default here would be the server's day.
   */
  it("is optional, and stays a string when given", () => {
    const absent = taskInput.safeParse(withTitle());
    expect(absent.success && absent.data.occursOn).toBeUndefined();

    const given = taskInput.safeParse(withTitle({ occursOn: "2026-08-06" }));
    expect(given.success && given.data.occursOn).toBe("2026-08-06");
  });

  it("rejects a date that does not exist", () => {
    expect(
      firstError(taskInput.safeParse(withTitle({ occursOn: "2026-02-31" }))),
    ).toBe(TASK_MESSAGES.occursOnInvalid);
  });

  it("rejects a timestamp masquerading as a day", () => {
    expect(
      taskInput.safeParse(withTitle({ occursOn: "2026-08-06T00:00:00Z" }))
        .success,
    ).toBe(false);
  });
});

describe("deadlineAt", () => {
  it("accepts an ISO instant from the client and a Date from the server", () => {
    const fromClient = taskInput.safeParse(
      withTitle({ deadlineAt: "2026-08-06T15:00:00.000Z" }),
    );
    const fromServer = taskInput.safeParse(
      withTitle({ deadlineAt: new Date("2026-08-06T15:00:00.000Z") }),
    );

    expect(fromClient.success && fromClient.data.deadlineAt).toBeInstanceOf(
      Date,
    );
    expect(fromClient.success && fromClient.data.deadlineAt?.toISOString()).toBe(
      fromServer.success ? fromServer.data.deadlineAt?.toISOString() : null,
    );
  });

  it("accepts an explicit offset as well as Z", () => {
    const result = taskInput.safeParse(
      withTitle({ deadlineAt: "2026-08-06T23:00:00+08:00" }),
    );
    expect(result.success && result.data.deadlineAt?.toISOString()).toBe(
      "2026-08-06T15:00:00.000Z",
    );
  });

  /** A zoneless wall clock has no meaning in a `timestamptz` — criterion 18. */
  it("rejects a local time with no zone", () => {
    expect(
      firstError(taskInput.safeParse(withTitle({ deadlineAt: "2026-08-06T23:00:00" }))),
    ).toBe(TASK_MESSAGES.deadlineInvalid);
    expect(
      taskInput.safeParse(withTitle({ deadlineAt: "2026-08-06" })).success,
    ).toBe(false);
  });

  it("distinguishes absent from cleared", () => {
    const absent = taskInput.safeParse(withTitle());
    expect(absent.success && absent.data.deadlineAt).toBeUndefined();

    const cleared = taskInput.safeParse(withTitle({ deadlineAt: null }));
    expect(cleared.success && cleared.data.deadlineAt).toBeNull();
  });
});

describe("status", () => {
  it("accepts the three stored values", () => {
    for (const status of ["todo", "in_progress", "done"] as const) {
      expect(taskInput.safeParse(withTitle({ status })).success).toBe(true);
    }
  });

  it("rejects anything else, including the label", () => {
    expect(
      firstError(taskInput.safeParse(withTitle({ status: "In progress" }))),
    ).toBe(TASK_MESSAGES.statusInvalid);
    expect(taskInput.safeParse(withTitle({ status: "archived" })).success).toBe(
      false,
    );
  });
});

describe("progressPct (criterion 12)", () => {
  it("accepts 0 and 100 inclusive", () => {
    expect(taskInput.safeParse(withTitle({ progressPct: 0 })).success).toBe(
      true,
    );
    expect(taskInput.safeParse(withTitle({ progressPct: 100 })).success).toBe(
      true,
    );
  });

  it("rejects −1 and 101 at the Zod boundary", () => {
    expect(
      firstError(taskInput.safeParse(withTitle({ progressPct: -1 }))),
    ).toBe(TASK_MESSAGES.progressOutOfRange);
    expect(
      firstError(taskInput.safeParse(withTitle({ progressPct: 101 }))),
    ).toBe(TASK_MESSAGES.progressOutOfRange);
  });

  it("rejects a fraction, since the column is an integer", () => {
    expect(
      firstError(taskInput.safeParse(withTitle({ progressPct: 42.5 }))),
    ).toBe(TASK_MESSAGES.progressNotWhole);
  });

  /**
   * The criterion stated as its own test: the pair `done` + 40% is valid input
   * and survives parsing with both facts intact. If anyone ever adds a
   * cross-field rule coercing one to the other, this is what fails.
   */
  it("accepts a done task sitting at 40% and changes neither value", () => {
    const result = taskInput.safeParse(
      withTitle({ status: "done", progressPct: 40 }),
    );
    expect(result.success && result.data.status).toBe("done");
    expect(result.success && result.data.progressPct).toBe(40);
  });

  it("accepts 100% on a task that is still in progress", () => {
    const result = taskInput.safeParse(
      withTitle({ status: "in_progress", progressPct: 100 }),
    );
    expect(result.success && result.data.status).toBe("in_progress");
    expect(result.success && result.data.progressPct).toBe(100);
  });
});

describe("taskUpdateInput", () => {
  it("needs a well-formed id", () => {
    expect(taskUpdateInput.safeParse({ status: "done" }).success).toBe(false);
    expect(
      taskUpdateInput.safeParse({ id: "not-a-uuid", status: "done" }).success,
    ).toBe(false);
  });

  it("accepts a patch naming a single field", () => {
    const result = taskUpdateInput.safeParse({ id: ID, status: "done" });
    expect(result.success && result.data).toEqual({ id: ID, status: "done" });
  });

  it("accepts a patch that only clears the description", () => {
    const result = taskUpdateInput.safeParse({ id: ID, description: null });
    expect(result.success && result.data.description).toBeNull();
  });

  it("rejects a patch that names nothing to change", () => {
    expect(firstError(taskUpdateInput.safeParse({ id: ID }))).toBe(
      TASK_MESSAGES.nothingToUpdate,
    );
  });

  it("still enforces every field rule", () => {
    expect(taskUpdateInput.safeParse({ id: ID, title: "  " }).success).toBe(
      false,
    );
    expect(taskUpdateInput.safeParse({ id: ID, progressPct: 101 }).success).toBe(
      false,
    );
  });
});

/**
 * A type-level assertion, not a runtime one: the inferred *input* type must let
 * a caller omit every optional field. If a transform ever swallows a key's
 * optionality, the create dialog would be forced to send `deadlineAt:
 * undefined` explicitly and this stops compiling.
 */
describe("inferred input type", () => {
  it("lets a caller send nothing but a title", () => {
    const minimal: z.input<typeof taskInput> = { title: "Write the migration" };
    const patch: z.input<typeof taskUpdateInput> = { id: ID, status: "done" };
    expect(taskInput.safeParse(minimal).success).toBe(true);
    expect(taskUpdateInput.safeParse(patch).success).toBe(true);
  });
});
