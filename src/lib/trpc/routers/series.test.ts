import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@supabase/supabase-js";

import type { Profile, ProfileStatus, TaskSeries } from "@/lib/db/schema";

/**
 * Tests for the series router.
 *
 * The repo is mocked, so nothing here touches a database — that the policies
 * really refuse another user's rows is proven in
 * `tests/integration/rls-boundary.test.ts`, and repeating it against a mock
 * would prove only that the mock agreed with itself. What is asserted here is
 * what this file owns: the procedure ladder, that Zod refuses a malformed rule
 * *before* any query runs, that ownership comes from the session, and that no
 * series mutation writes an occurrence.
 */

vi.mock("@/lib/db/repos/series", () => ({
  listActive: vi.fn(),
  findOwn: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  softDelete: vi.fn(),
}));

vi.mock("@/lib/db/repos/tags", () => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  tagsForOccurrences: vi.fn(),
  tagsForSeries: vi.fn(),
  setForOccurrence: vi.fn(),
  setForOccurrenceIn: vi.fn(),
  setForSeries: vi.fn(),
}));

import * as seriesRepo from "@/lib/db/repos/series";
import * as tagsRepo from "@/lib/db/repos/tags";
import { createCallerFactory, type Context } from "../server";
import { seriesRouter } from "./series";

const createCaller = createCallerFactory(seriesRouter);

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

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

function fakeProfile(status: ProfileStatus): Profile {
  return {
    id: USER_ID,
    email: "member@example.com",
    displayName: "Test Member",
    timezone: "UTC",
    role: "member",
    status,
    approvedAt: null,
    approvedBy: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}

function contextFor(status: ProfileStatus): Context {
  return { supabase: null, user: fakeUser(), profile: fakeProfile(status) };
}

const anonymousContext: Context = { supabase: null, user: null, profile: null };

function fakeSeries(overrides: Partial<TaskSeries> = {}): TaskSeries {
  return {
    id: SERIES_ID,
    userId: USER_ID,
    title: "Team standup",
    description: null,
    freq: "weekly",
    interval: 2,
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
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    reminderLeadMinutes: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    deletedAt: null,
    ...overrides,
  };
}

const VALID_INPUT = {
  title: "Team standup",
  startsOn: "2026-01-05",
  deadlineTime: "09:00",
  rule: { freq: "weekly" as const, interval: 2, byweekday: ["MO" as const, "WE" as const] },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(seriesRepo.listActive).mockResolvedValue([]);
  vi.mocked(tagsRepo.setForSeries).mockResolvedValue(undefined);
  // Phase 4: every series read resolves its template tags. None of the
  // assertions in this file are about them.
  vi.mocked(tagsRepo.tagsForSeries).mockResolvedValue([]);
});

describe("the procedure ladder", () => {
  it("rejects an anonymous caller as UNAUTHORIZED", async () => {
    await expect(createCaller(anonymousContext).list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  /**
   * A repeat rule carries a title and notes, which is task data — so the same
   * rung applies as for tasks. An authenticated but ungated account must not
   * reach it.
   */
  it.each(["pending", "rejected", "suspended"] as const)(
    "rejects a %s account as FORBIDDEN",
    async (status) => {
      await expect(createCaller(contextFor(status)).list()).rejects.toMatchObject(
        { code: "FORBIDDEN" },
      );
    },
  );

  it("never reaches the database for a gated caller", async () => {
    await expect(createCaller(contextFor("pending")).list()).rejects.toThrow();
    expect(seriesRepo.listActive).not.toHaveBeenCalled();
  });

  it("lets an active account through", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([fakeSeries()]);
    await expect(createCaller(contextFor("active")).list()).resolves.toHaveLength(
      1,
    );
  });
});

describe("input validation happens before any query", () => {
  it.each([
    ["a weekly rule with no days", { freq: "weekly", byweekday: [] }],
    ["a monthly rule with no mode", { freq: "monthly" }],
    ["by_date with no day", { freq: "monthly", monthMode: "by_date" }],
    [
      "by_nth_weekday with half a rule",
      { freq: "monthly", monthMode: "by_nth_weekday", nthWeek: 2 },
    ],
    ["ends on with no date", { freq: "daily", endsMode: "on" }],
    ["ends after with no count", { freq: "daily", endsMode: "after" }],
    ["an interval of 0", { freq: "daily", interval: 0 }],
    ["a frequency that does not exist", { freq: "hourly" }],
  ])("rejects %s without calling the repo", async (_label, rule) => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createCaller(contextFor("active")).create({ ...VALID_INPUT, rule } as any),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(seriesRepo.create).not.toHaveBeenCalled();
  });

  it("rejects an end date before the start date", async () => {
    await expect(
      createCaller(contextFor("active")).create({
        ...VALID_INPUT,
        startsOn: "2026-06-01",
        rule: { freq: "daily", endsMode: "on", endsOn: "2026-01-01" },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects an impossible start date", async () => {
    await expect(
      createCaller(contextFor("active")).create({
        ...VALID_INPUT,
        startsOn: "2026-02-31",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("ownership comes from the session, not the input", () => {
  it("passes the verified user id as claims", async () => {
    vi.mocked(seriesRepo.create).mockResolvedValue(fakeSeries());
    await createCaller(contextFor("active")).create(VALID_INPUT);

    expect(vi.mocked(seriesRepo.create).mock.calls[0][0]).toEqual({
      sub: USER_ID,
      email: "member@example.com",
    });
  });

  it("ignores a userId smuggled into the input", async () => {
    vi.mocked(seriesRepo.create).mockResolvedValue(fakeSeries());
    await createCaller(contextFor("active")).create({
      ...VALID_INPUT,
      userId: "22222222-2222-4222-8222-222222222222",
    } as unknown as typeof VALID_INPUT);

    expect(vi.mocked(seriesRepo.create).mock.calls[0][1]).not.toHaveProperty(
      "userId",
    );
  });
});

describe("create", () => {
  it("normalises the rule so a stale field cannot break 0005's CHECKs", async () => {
    // The editor's state still holds the weekdays after switching Weekly →
    // Monthly. `task_series_weekly_days_check` would refuse the row.
    vi.mocked(seriesRepo.create).mockResolvedValue(fakeSeries());

    await createCaller(contextFor("active")).create({
      ...VALID_INPUT,
      rule: {
        freq: "monthly",
        byweekday: ["MO", "WE"],
        monthMode: "by_date",
        monthDay: 15,
      },
    });

    expect(vi.mocked(seriesRepo.create).mock.calls[0][1].rule).toMatchObject({
      freq: "monthly",
      byweekday: [],
      monthDay: 15,
      nthWeek: null,
      nthWeekday: null,
    });
  });

  it("passes the deadline time through as a bare wall clock", async () => {
    vi.mocked(seriesRepo.create).mockResolvedValue(fakeSeries());
    await createCaller(contextFor("active")).create(VALID_INPUT);

    expect(vi.mocked(seriesRepo.create).mock.calls[0][1]).toMatchObject({
      deadlineTime: "09:00",
      startsOn: "2026-01-05",
    });
  });
});

describe("update and remove", () => {
  it("reports a series that is not the caller's as NOT_FOUND, never FORBIDDEN", async () => {
    vi.mocked(seriesRepo.update).mockResolvedValue(null);
    vi.mocked(seriesRepo.softDelete).mockResolvedValue(false);
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(null);

    const caller = createCaller(contextFor("active"));

    await expect(caller.get({ id: SERIES_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller.update({ ...VALID_INPUT, id: SERIES_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(caller.remove({ id: SERIES_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("deletes softly, through the repo that stamps deleted_at", async () => {
    // Acceptance criterion 17 lives in the soft delete: the untouched future
    // stops being projected while the recorded rows survive.
    vi.mocked(seriesRepo.softDelete).mockResolvedValue(true);
    await createCaller(contextFor("active")).remove({ id: SERIES_ID });

    expect(seriesRepo.softDelete).toHaveBeenCalledWith(
      { sub: USER_ID, email: "member@example.com" },
      SERIES_ID,
    );
  });

  it("rejects a malformed id at the boundary rather than as a cast error", async () => {
    await expect(
      createCaller(contextFor("active")).remove({ id: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("serialisation keeps the client's inferred type honest", () => {
  it("emits ISO strings for instants and the rule as one nested object", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([fakeSeries()]);
    const [series] = await createCaller(contextFor("active")).list();

    expect(series.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(series.startsOn).toBe("2026-01-05");
    expect(series.rule).toEqual({
      freq: "weekly",
      interval: 2,
      byweekday: ["MO", "WE"],
      monthMode: null,
      monthDay: null,
      nthWeek: null,
      nthWeekday: null,
      endsMode: "never",
      endsOn: null,
      endsCount: null,
    });
  });

  it("trims the HH:MM:SS Postgres reads a `time` column back as", async () => {
    // The editor's control speaks HH:MM. Trimmed once, here, rather than in
    // every consumer.
    vi.mocked(seriesRepo.listActive).mockResolvedValue([fakeSeries()]);
    const [series] = await createCaller(contextFor("active")).list();
    expect(series.deadlineTime).toBe("09:00");
  });

  it("does not expose userId", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([fakeSeries()]);
    const [series] = await createCaller(contextFor("active")).list();
    expect(series).not.toHaveProperty("userId");
  });
});

/**
 * Acceptance criterion 12, as a source-level guard. A single `dbAdmin` import
 * would let a query escape the RLS boundary while every assertion above still
 * passed, and it is one line away at any time.
 */
describe("the access model", () => {
  it("imports neither dbAdmin nor Drizzle", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "series.ts"), "utf8");

    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/dbAdmin|db\/client|drizzle-orm/);
  });

  it("writes no occurrence when a rule is created, edited or deleted", async () => {
    // Criteria 15 and 17 fall out of this rather than being implemented: a rule
    // change disturbs no row, so no row can lose the work recorded against it.
    const occurrencesSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "series.ts"),
      "utf8",
    );
    expect(occurrencesSource).not.toMatch(/repos\/occurrences/);
  });
});
