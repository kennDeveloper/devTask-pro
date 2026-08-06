import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

import type { Profile, ProfileStatus, TaskOccurrence } from "@/lib/db/schema";

/**
 * Tests for the task router.
 *
 * The repo is mocked, so nothing here touches a database — the RLS boundary is
 * proven for real in `tests/integration/rls-boundary.test.ts`, and repeating it
 * against a mock would prove only that the mock was written to agree. What is
 * asserted here is the part this file owns: that the procedure ladder rejects the
 * accounts it should, that Zod refuses bad input *before* any query runs, that the
 * caller's identity comes from the session rather than the input, and that the
 * user's own timezone decides which day "today" is.
 */

vi.mock("@/lib/db/repos/occurrences", () => ({
  listAll: vi.fn(),
  listForDay: vi.fn(),
  listOverdue: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

import * as occurrences from "@/lib/db/repos/occurrences";
import { createCallerFactory, type Context } from "../server";
import { taskRouter } from "./task";

const createCaller = createCallerFactory(taskRouter);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";

function fakeUser(): User {
  return {
    id: USER_ID,
    email: "member@example.com",
    aud: "authenticated",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  } as User;
}

function fakeProfile(status: ProfileStatus, timezone = "UTC"): Profile {
  return {
    id: USER_ID,
    email: "member@example.com",
    displayName: "Test Member",
    timezone,
    role: "member",
    status,
    approvedAt: null,
    approvedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function contextFor(status: ProfileStatus, timezone = "UTC"): Context {
  return { supabase: null, user: fakeUser(), profile: fakeProfile(status, timezone) };
}

const anonymousContext: Context = { supabase: null, user: null, profile: null };

function fakeRow(overrides: Partial<TaskOccurrence> = {}): TaskOccurrence {
  return {
    id: TASK_ID,
    userId: USER_ID,
    seriesId: null,
    title: "Write the tests",
    description: null,
    occursOn: "2026-08-06",
    deadlineAt: null,
    status: "todo",
    progressPct: 0,
    completedAt: null,
    createdAt: new Date("2026-08-06T00:00:00Z"),
    updatedAt: new Date("2026-08-06T00:00:00Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the procedure ladder", () => {
  it("rejects an anonymous caller as UNAUTHORIZED", async () => {
    const caller = createCaller(anonymousContext);
    await expect(caller.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  /**
   * The distinction that matters: these accounts are authenticated. Only
   * `activeProcedure` keeps them out of application data, which is why every
   * procedure in this router sits on it rather than on `protectedProcedure`.
   */
  it.each(["pending", "rejected", "suspended"] as const)(
    "rejects a %s account as FORBIDDEN",
    async (status) => {
      const caller = createCaller(contextFor(status));
      await expect(caller.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    },
  );

  it("never reaches the database for a rejected caller", async () => {
    const caller = createCaller(contextFor("pending"));
    await expect(caller.list()).rejects.toThrow();
    expect(occurrences.listAll).not.toHaveBeenCalled();
  });

  it("lets an active account through", async () => {
    vi.mocked(occurrences.listAll).mockResolvedValue([fakeRow()]);
    const caller = createCaller(contextFor("active"));
    await expect(caller.list()).resolves.toHaveLength(1);
  });
});

describe("input validation happens before any query", () => {
  it.each([
    ["progress above 100", { title: "x", progressPct: 101 }],
    ["negative progress", { title: "x", progressPct: -1 }],
    ["fractional progress", { title: "x", progressPct: 42.5 }],
    ["an empty title", { title: "   " }],
    ["an impossible date", { title: "x", occursOn: "2026-02-31" }],
    ["a status that does not exist", { title: "x", status: "archived" }],
  ])("rejects %s without calling the repo", async (_label, input) => {
    const caller = createCaller(contextFor("active"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      caller.create(input as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(occurrences.create).not.toHaveBeenCalled();
  });

  it("accepts progress at both ends of the range", async () => {
    vi.mocked(occurrences.create).mockResolvedValue(fakeRow());
    const caller = createCaller(contextFor("active"));

    await expect(
      caller.create({ title: "x", progressPct: 0 }),
    ).resolves.toBeTruthy();
    await expect(
      caller.create({ title: "x", progressPct: 100 }),
    ).resolves.toBeTruthy();
  });

  /**
   * Criterion 12: progress and status are independent. A done task at 40% must be
   * accepted, and so must an in-progress task at 100% — neither is coerced.
   */
  it("accepts a done task at 40% and an in-progress task at 100%", async () => {
    vi.mocked(occurrences.create).mockResolvedValue(fakeRow());
    const caller = createCaller(contextFor("active"));

    await caller.create({ title: "x", status: "done", progressPct: 40 });
    expect(vi.mocked(occurrences.create).mock.calls[0][1]).toMatchObject({
      status: "done",
      progressPct: 40,
    });

    await caller.create({ title: "x", status: "in_progress", progressPct: 100 });
    expect(vi.mocked(occurrences.create).mock.calls[1][1]).toMatchObject({
      status: "in_progress",
      progressPct: 100,
    });
  });

  it("rejects an update that names nothing to change", async () => {
    const caller = createCaller(contextFor("active"));
    await expect(caller.update({ id: TASK_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(occurrences.update).not.toHaveBeenCalled();
  });
});

describe("ownership comes from the session, not the input", () => {
  it("passes the verified user id as claims", async () => {
    vi.mocked(occurrences.listAll).mockResolvedValue([]);
    const caller = createCaller(contextFor("active"));
    await caller.list();

    expect(occurrences.listAll).toHaveBeenCalledWith({
      sub: USER_ID,
      email: "member@example.com",
    });
  });

  /**
   * The schema has no `userId` field at all, so a client cannot even express
   * "create this as someone else". This pins that: the extra key is stripped by
   * Zod and never reaches the repo, where it would otherwise be spread into the
   * insert.
   */
  it("ignores a userId smuggled into the input", async () => {
    vi.mocked(occurrences.create).mockResolvedValue(fakeRow());
    const caller = createCaller(contextFor("active"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await caller.create({ title: "x", userId: OTHER_ID } as any);

    const [claims, input] = vi.mocked(occurrences.create).mock.calls[0];
    expect(claims.sub).toBe(USER_ID);
    expect(input).not.toHaveProperty("userId");
  });
});

describe("today is the caller's day, not the server's", () => {
  /**
   * Criterion 19. At 22:00 UTC on the 6th it is already the 7th in Manila, so a
   * caller in that zone must get the 7th — the server's own date is never the
   * answer, and the client is never asked.
   */
  it("resolves listForDay from the profile timezone", async () => {
    vi.mocked(occurrences.listForDay).mockResolvedValue([]);
    const caller = createCaller(contextFor("active", "Asia/Manila"));

    await caller.listForDay({ now: new Date("2026-08-06T22:00:00Z") });

    expect(occurrences.listForDay).toHaveBeenCalledWith(
      expect.anything(),
      "2026-08-07",
    );
  });

  it("gives a UTC caller the UTC day for the same instant", async () => {
    vi.mocked(occurrences.listForDay).mockResolvedValue([]);
    const caller = createCaller(contextFor("active", "UTC"));

    await caller.listForDay({ now: new Date("2026-08-06T22:00:00Z") });

    expect(occurrences.listForDay).toHaveBeenCalledWith(
      expect.anything(),
      "2026-08-06",
    );
  });

  it("defaults a created task to the caller's day", async () => {
    vi.mocked(occurrences.create).mockResolvedValue(fakeRow());
    const caller = createCaller(contextFor("active", "Asia/Manila"));

    await caller.create({ title: "x", now: new Date("2026-08-06T22:00:00Z") });

    expect(vi.mocked(occurrences.create).mock.calls[0][1]).toMatchObject({
      occursOn: "2026-08-07",
    });
  });

  it("honours an explicit day over the computed one", async () => {
    vi.mocked(occurrences.listForDay).mockResolvedValue([]);
    const caller = createCaller(contextFor("active", "Asia/Manila"));

    await caller.listForDay({ occursOn: "2026-01-01" });

    expect(occurrences.listForDay).toHaveBeenCalledWith(
      expect.anything(),
      "2026-01-01",
    );
  });
});

describe("serialisation keeps the client's inferred type honest", () => {
  /**
   * The link has no transformer, so a `Date` would arrive as a string while the
   * inferred type still claimed `Date` — a mismatch that type-checks and then
   * fails at the first `.getTime()`. Dates go out as ISO strings; `occursOn`
   * stays a bare calendar day.
   */
  it("emits ISO strings for instants and leaves occursOn a plain date", async () => {
    vi.mocked(occurrences.listAll).mockResolvedValue([
      fakeRow({
        deadlineAt: new Date("2026-08-06T15:00:00Z"),
        completedAt: new Date("2026-08-06T16:00:00Z"),
      }),
    ]);

    const [task] = await createCaller(contextFor("active")).list();

    expect(task.deadlineAt).toBe("2026-08-06T15:00:00.000Z");
    expect(task.completedAt).toBe("2026-08-06T16:00:00.000Z");
    expect(task.occursOn).toBe("2026-08-06");
  });

  it("does not expose userId", async () => {
    vi.mocked(occurrences.listAll).mockResolvedValue([fakeRow()]);
    const [task] = await createCaller(contextFor("active")).list();
    expect(task).not.toHaveProperty("userId");
  });
});

describe("a row that RLS filtered out is NOT_FOUND, never FORBIDDEN", () => {
  /**
   * Answering FORBIDDEN would confirm that a task exists but belongs to somebody
   * else — which is precisely the fact this application promises never to reveal.
   * "Not yours" and "not there" must be indistinguishable from outside.
   */
  it("reports a missing update target as NOT_FOUND", async () => {
    vi.mocked(occurrences.update).mockResolvedValue(null);
    const caller = createCaller(contextFor("active"));

    await expect(
      caller.update({ id: TASK_ID, title: "new" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reports a missing delete target as NOT_FOUND", async () => {
    vi.mocked(occurrences.remove).mockResolvedValue(false);
    const caller = createCaller(contextFor("active"));

    await expect(caller.remove({ id: TASK_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
