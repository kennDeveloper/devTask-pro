import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

import type {
  Profile,
  ProfileStatus,
  TaskOccurrence,
  TaskSeries,
} from "@/lib/db/schema";

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
  listForSeries: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  materialize: vi.fn(),
}));

/**
 * Phase 3 put `src/lib/tasks/feed.ts` between this router and the repos, so
 * every read now also asks for the caller's live series. Mocked to none by
 * default: the merge is `feed.test.ts`'s subject, and what this file owns is the
 * procedure ladder, the Zod boundary, and where the caller's identity comes
 * from.
 */
vi.mock("@/lib/db/repos/series", () => ({
  listActive: vi.fn(),
  findOwn: vi.fn(),
}));

import * as occurrences from "@/lib/db/repos/occurrences";
import * as seriesRepo from "@/lib/db/repos/series";
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
  // Every read goes through the feed, which asks for the caller's live series.
  // None, unless a test says otherwise.
  vi.mocked(seriesRepo.listActive).mockResolvedValue([]);
  vi.mocked(occurrences.listAll).mockResolvedValue([]);
  vi.mocked(occurrences.listForDay).mockResolvedValue([]);
  vi.mocked(occurrences.listOverdue).mockResolvedValue([]);
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

/**
 * ===========================================================================
 * MATERIALISE ON TOUCH
 * ===========================================================================
 *
 * `task.update` accepts a row's uuid *or* the synthetic reference a projected
 * occurrence travels under, and touching a projection is what turns it into a
 * row. The branch lives on the server so the series can be re-checked; what is
 * asserted here is that the branch exists, that it re-checks, and that the
 * client cannot reach a date its rule does not name.
 */
describe("task.update materialises a projected occurrence", () => {
  const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const EPOCH = new Date("2026-01-01T00:00:00.000Z");

  /** Weekly on Mondays and Wednesdays from Mon 5 Jan, due 09:00. */
  function fakeSeries(overrides: Partial<TaskSeries> = {}): TaskSeries {
    return {
      id: SERIES_ID,
      userId: USER_ID,
      title: "Team standup",
      description: null,
      freq: "weekly",
      interval: 1,
      byweekday: ["MO", "WE"],
      monthMode: null,
      monthDay: null,
      nthWeek: null,
      nthWeekday: null,
      startsOn: "2026-01-05",
      deadlineTime: "09:00:00",
      endsMode: "never",
      endsOn: null,
      endsCount: null,
      rrule: "FREQ=WEEKLY;BYDAY=MO,WE",
      reminderLeadMinutes: null,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      deletedAt: null,
      ...overrides,
    };
  }

  const VIRTUAL_ID = `series:${SERIES_ID}:2026-01-07`;

  beforeEach(() => {
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(fakeSeries());
    vi.mocked(occurrences.materialize).mockResolvedValue(
      fakeRow({ seriesId: SERIES_ID, occursOn: "2026-01-07" }),
    );
  });

  it("writes a row instead of patching one", async () => {
    const caller = createCaller(contextFor("active"));
    await caller.update({ id: VIRTUAL_ID, status: "in_progress", progressPct: 60 });

    expect(occurrences.update).not.toHaveBeenCalled();
    expect(occurrences.materialize).toHaveBeenCalledWith(
      { sub: USER_ID, email: "member@example.com" },
      expect.objectContaining({
        seriesId: SERIES_ID,
        occursOn: "2026-01-07",
        status: "in_progress",
        progressPct: 60,
      }),
    );
  });

  it("still patches a row when given a real uuid", async () => {
    vi.mocked(occurrences.update).mockResolvedValue(fakeRow());
    const caller = createCaller(contextFor("active"));

    await caller.update({ id: TASK_ID, status: "done" });

    expect(occurrences.materialize).not.toHaveBeenCalled();
    expect(occurrences.update).toHaveBeenCalled();
  });

  it("reports a date the rule does not name as NOT_FOUND", async () => {
    // The 6th is a Tuesday; the rule names Mondays and Wednesdays. Without this
    // check a client could plant a row belonging to a series on a day that
    // series never produces.
    const caller = createCaller(contextFor("active"));

    await expect(
      caller.update({ id: `series:${SERIES_ID}:2026-01-06`, status: "done" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(occurrences.materialize).not.toHaveBeenCalled();
  });

  it("reports somebody else's series as NOT_FOUND, never FORBIDDEN", async () => {
    // `findOwn` returns null for "not yours", "no such series" and "deleted"
    // alike — from outside they are the same fact, and distinguishing them would
    // confirm the existence of another user's data.
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(null);
    const caller = createCaller(contextFor("active"));

    await expect(
      caller.update({ id: VIRTUAL_ID, status: "done" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let a patch move a projected occurrence to another day", async () => {
    // The day of a recurring occurrence belongs to the rule. Forwarding
    // `occursOn` would write a row on a date the rule does not name — the thing
    // the check above exists to prevent, arriving through the front door.
    const caller = createCaller(contextFor("active"));
    await caller.update({ id: VIRTUAL_ID, occursOn: "2026-02-02", status: "done" });

    expect(vi.mocked(occurrences.materialize).mock.calls[0][1]).toMatchObject({
      occursOn: "2026-01-07",
    });
  });

  it("rejects a malformed reference at the Zod boundary, before any query", async () => {
    const caller = createCaller(contextFor("active"));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      caller.update({ id: "series:nope:2026-01-07", status: "done" } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(seriesRepo.findOwn).not.toHaveBeenCalled();
  });

  /**
   * `task.remove` deliberately keeps a plain uuid: deleting an occurrence nobody
   * has touched would be "skip this one occurrence", which is out of v1.
   */
  it("refuses to delete a projected occurrence", async () => {
    const caller = createCaller(contextFor("active"));

    await expect(caller.remove({ id: VIRTUAL_ID })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(occurrences.remove).not.toHaveBeenCalled();
  });
});

describe("the feed reaches the client", () => {
  it("marks a stored row as not virtual", async () => {
    vi.mocked(occurrences.listAll).mockResolvedValue([fakeRow()]);
    const [task] = await createCaller(contextFor("active")).list();

    expect(task.virtual).toBe(false);
    expect(task.seriesId).toBeNull();
  });

  it("returns projections of a live series as virtual, with a parseable id", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([
      {
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        userId: USER_ID,
        title: "Team standup",
        description: null,
        freq: "weekly",
        interval: 1,
        byweekday: ["MO"],
        monthMode: null,
        monthDay: null,
        nthWeek: null,
        nthWeekday: null,
        startsOn: "2026-01-05",
        deadlineTime: "09:00:00",
        endsMode: "never",
        endsOn: null,
        endsCount: null,
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        reminderLeadMinutes: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        deletedAt: null,
      },
    ]);

    const feed = await createCaller(contextFor("active")).listForDay({
      occursOn: "2026-01-05",
    });

    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      virtual: true,
      seriesId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      occursOn: "2026-01-05",
      title: "Team standup",
      status: "todo",
      progressPct: 0,
    });
    expect(feed[0].id).toBe("series:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb:2026-01-05");
    // Serialised, because the link has no transformer.
    expect(feed[0].deadlineAt).toBe("2026-01-05T09:00:00.000Z");
  });
});
