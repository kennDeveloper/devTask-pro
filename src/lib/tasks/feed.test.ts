import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskOccurrence, TaskSeries } from "@/lib/db/schema";

/**
 * The feed — where the rule, the rows and the window meet.
 *
 * The two repos are mocked, so nothing here touches a database: what is asserted
 * is the merge, the window and the materialisation guard, which is the logic
 * this module actually owns. That the policies really refuse another user's rows
 * is `tests/integration/rls-boundary.test.ts`, and repeating it against a mock
 * would prove only that the mock agreed with itself.
 */

vi.mock("@/lib/db/repos/occurrences", () => ({
  listForDay: vi.fn(),
  listOverdue: vi.fn(),
  listAll: vi.fn(),
  materialize: vi.fn(),
}));

vi.mock("@/lib/db/repos/series", () => ({
  listActive: vi.fn(),
  findOwn: vi.fn(),
}));

vi.mock("@/lib/db/repos/tags", () => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  tagsForOccurrences: vi.fn(),
  tagsForSeries: vi.fn(),
  tagsForFeed: vi.fn(),
  setForOccurrence: vi.fn(),
  setForOccurrenceIn: vi.fn(),
  setForSeries: vi.fn(),
}));

import * as occurrences from "@/lib/db/repos/occurrences";
import * as seriesRepo from "@/lib/db/repos/series";
import * as tagsRepo from "@/lib/db/repos/tags";

import {
  feedWindow,
  FEED_WINDOW_BACK_DAYS,
  FEED_WINDOW_FORWARD_DAYS,
  fromRow,
  listAllFeed,
  listDayFeed,
  listOverdueFeed,
  materializeOccurrence,
  mergeOccurrences,
  occurrenceDeadline,
  seriesOccurrences,
} from "./feed";
import { virtualOccurrenceId } from "./occurrence-ref";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLAIMS = { sub: USER_ID };

const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** A weekly Monday/Wednesday series with a 09:00 deadline, starting Mon 5 Jan. */
function makeSeries(overrides: Partial<TaskSeries> = {}): TaskSeries {
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

function makeRow(overrides: Partial<TaskOccurrence> = {}): TaskOccurrence {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    userId: USER_ID,
    seriesId: null,
    title: "A one-off",
    description: null,
    occursOn: "2026-01-05",
    deadlineAt: null,
    status: "todo",
    progressPct: 0,
    reminderLeadMinutes: null,
    completedAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(occurrences.listForDay).mockResolvedValue([]);
  vi.mocked(occurrences.listOverdue).mockResolvedValue([]);
  vi.mocked(occurrences.listAll).mockResolvedValue([]);
  vi.mocked(seriesRepo.listActive).mockResolvedValue([]);
  // Tags are their own phase-4 concern; every read now asks for them, and none
  // of the assertions in this file are about them.
  vi.mocked(tagsRepo.tagsForOccurrences).mockResolvedValue([]);
  vi.mocked(tagsRepo.tagsForSeries).mockResolvedValue([]);
  vi.mocked(tagsRepo.tagsForFeed).mockResolvedValue({
    occurrenceLinks: [],
    seriesLinks: [],
  });
  vi.mocked(tagsRepo.setForOccurrence).mockResolvedValue(undefined);
});

describe("feedWindow", () => {
  it("projects one day for /today", () => {
    expect(feedWindow("day", "2026-01-05")).toEqual({
      from: "2026-01-05",
      to: "2026-01-05",
    });
  });

  it("reaches backwards only for /overdue — a future occurrence cannot be late", () => {
    const window = feedWindow("overdue", "2026-03-01");
    expect(window.to).toBe("2026-03-01");
    expect(window.from).toBe("2026-01-30");
  });

  it("reaches both ways for /tasks", () => {
    const window = feedWindow("all", "2026-03-01");
    expect(window.from).toBe("2026-01-30");
    expect(window.to).toBe("2026-04-30");
  });

  it("uses the declared constants, so the reach is one decision", () => {
    expect(FEED_WINDOW_BACK_DAYS).toBeGreaterThan(0);
    expect(FEED_WINDOW_FORWARD_DAYS).toBeGreaterThan(0);
  });
});

describe("occurrenceDeadline — criterion 20", () => {
  it("resolves the wall clock per date, in the account holder's zone", () => {
    const series = makeSeries({ deadlineTime: "09:00:00" });

    // America/New_York springs forward on 2026-03-08. Nine in the morning on
    // both sides, at two different UTC instants.
    expect(
      occurrenceDeadline(series, "2026-03-06", "America/New_York")?.toISOString(),
    ).toBe("2026-03-06T14:00:00.000Z");
    expect(
      occurrenceDeadline(series, "2026-03-09", "America/New_York")?.toISOString(),
    ).toBe("2026-03-09T13:00:00.000Z");
  });

  it("accepts the HH:MM:SS Postgres reads a `time` column back as", () => {
    expect(
      occurrenceDeadline(makeSeries({ deadlineTime: "09:00:00" }), "2026-01-05", "UTC")
        ?.toISOString(),
    ).toBe("2026-01-05T09:00:00.000Z");
  });

  it("is null when the series has no deadline time — never overdue, criterion 8", () => {
    expect(
      occurrenceDeadline(makeSeries({ deadlineTime: null }), "2026-01-05", "UTC"),
    ).toBeNull();
  });
});

describe("seriesOccurrences", () => {
  it("projects every date the rule names inside the window", () => {
    const projected = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-18" },
      "UTC",
    );

    expect(projected.map((o) => o.occursOn)).toEqual([
      "2026-01-05",
      "2026-01-07",
      "2026-01-12",
      "2026-01-14",
    ]);
  });

  it("marks them virtual and gives them a parseable synthetic id", () => {
    const [first] = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-05" },
      "UTC",
    );

    expect(first.virtual).toBe(true);
    expect(first.id).toBe(virtualOccurrenceId(SERIES_ID, "2026-01-05"));
    expect(first.seriesId).toBe(SERIES_ID);
  });

  it("starts every projection at the column defaults, because nobody has touched it", () => {
    const [first] = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-05" },
      "UTC",
    );
    expect(first.status).toBe("todo");
    expect(first.progressPct).toBe(0);
    expect(first.completedAt).toBeNull();
  });

  it("carries the series' reminder lead, because nobody has touched this date", () => {
    // The reminder job reads this feed rather than querying the tables, so a
    // projection without its series' lead is a reminder that never fires for
    // any occurrence the user has not already opened.
    const projected = seriesOccurrences(
      makeSeries({ reminderLeadMinutes: 30 }),
      { from: "2026-01-05", to: "2026-01-07" },
      "UTC",
    );

    expect(projected).not.toHaveLength(0);
    for (const entry of projected) {
      expect(entry.reminderLeadMinutes).toBe(30);
    }
  });

  it("borrows the series' timestamps rather than reading a clock", () => {
    // A `new Date()` here would differ between the SSR pass and any later
    // render — the class of bug criterion 19 exists to rule out.
    const [first] = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-05" },
      "UTC",
    );
    expect(first.createdAt).toEqual(EPOCH);
  });
});

describe("mergeOccurrences", () => {
  it("prefers the stored row over the projection for the same date — criterion 14", () => {
    const touched = fromRow(
      makeRow({
        id: "44444444-4444-4444-8444-444444444444",
        seriesId: SERIES_ID,
        occursOn: "2026-01-07",
        status: "in_progress",
        progressPct: 60,
      }),
    );
    const projected = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-14" },
      "UTC",
    );

    const merged = mergeOccurrences([touched], projected);

    // One entry for the 7th, and it is the row.
    const seventh = merged.filter((o) => o.occursOn === "2026-01-07");
    expect(seventh).toHaveLength(1);
    expect(seventh[0].virtual).toBe(false);
    expect(seventh[0].status).toBe("in_progress");
    expect(seventh[0].progressPct).toBe(60);

    // And the neighbours are untouched projections.
    for (const day of ["2026-01-05", "2026-01-12", "2026-01-14"]) {
      const entry = merged.find((o) => o.occursOn === day)!;
      expect(entry.virtual).toBe(true);
      expect(entry.status).toBe("todo");
      expect(entry.progressPct).toBe(0);
    }
  });

  /**
   * Acceptance criterion 15. After a rule edit, a row can sit on a date the new
   * rule does not name. The merge is a *union*, so it still appears — filtering
   * to dates the rule names would silently drop exactly the work the criterion
   * says must be kept.
   */
  it("keeps a row on a date the rule no longer names", () => {
    const orphan = fromRow(
      makeRow({
        id: "55555555-5555-4555-8555-555555555555",
        seriesId: SERIES_ID,
        occursOn: "2026-01-06",
        status: "done",
        progressPct: 100,
      }),
    );
    // The rule names Mondays and Wednesdays; the 6th is a Tuesday.
    const projected = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-14" },
      "UTC",
    );

    const merged = mergeOccurrences([orphan], projected);
    const sixth = merged.find((o) => o.occursOn === "2026-01-06");

    expect(sixth).toBeDefined();
    expect(sixth!.status).toBe("done");
    expect(sixth!.progressPct).toBe(100);
  });

  it("never lets a one-off row swallow a series projection on the same day", () => {
    // One-offs carry `series_id IS NULL` and so have no merge key at all.
    const oneOff = fromRow(makeRow({ occursOn: "2026-01-05" }));
    const projected = seriesOccurrences(
      makeSeries(),
      { from: "2026-01-05", to: "2026-01-05" },
      "UTC",
    );

    expect(mergeOccurrences([oneOff], projected)).toHaveLength(2);
  });

  it("keeps two different series apart on the same day", () => {
    const other = makeSeries({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    const window = { from: "2026-01-05", to: "2026-01-05" };

    const merged = mergeOccurrences(
      [],
      [
        ...seriesOccurrences(makeSeries(), window, "UTC"),
        ...seriesOccurrences(other, window, "UTC"),
      ],
    );
    expect(merged).toHaveLength(2);
  });
});

describe("listDayFeed", () => {
  it("merges the day's rows with the day's projections", async () => {
    vi.mocked(occurrences.listForDay).mockResolvedValue([
      makeRow({ occursOn: "2026-01-05", title: "A one-off" }),
    ]);
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);

    const feed = await listDayFeed(CLAIMS, "2026-01-05", "UTC");

    expect(feed.map((o) => o.title)).toEqual(["Team standup", "A one-off"]);
    // Timed work first: the standup has a 09:00 deadline, the one-off has none.
    expect(feed[0].deadlineAt?.toISOString()).toBe("2026-01-05T09:00:00.000Z");
    expect(feed[1].deadlineAt).toBeNull();
  });

  it("projects only that day", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);
    const feed = await listDayFeed(CLAIMS, "2026-01-07", "UTC");

    expect(feed.map((o) => o.occursOn)).toEqual(["2026-01-07"]);
  });

  it("projects nothing on a day the rule does not name", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);
    // The 6th is a Tuesday; the rule names Mondays and Wednesdays.
    await expect(listDayFeed(CLAIMS, "2026-01-06", "UTC")).resolves.toEqual([]);
  });

  /**
   * Acceptance criterion 17. A deleted series is not returned by `listActive`,
   * so nothing is projected — while its rows are read by the ordinary
   * `listForDay` and survive untouched.
   */
  it("projects nothing for a deleted series but keeps its rows", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([]);
    vi.mocked(occurrences.listForDay).mockResolvedValue([
      makeRow({
        seriesId: SERIES_ID,
        occursOn: "2026-01-05",
        title: "Team standup",
        status: "done",
      }),
    ]);

    const feed = await listDayFeed(CLAIMS, "2026-01-05", "UTC");
    expect(feed).toHaveLength(1);
    expect(feed[0].status).toBe("done");
    expect(feed[0].virtual).toBe(false);
  });
});

describe("listAllFeed", () => {
  it("keeps a materialised row far outside the projection window", async () => {
    // Phase 2's e2e seeds a task 400 days back and asserts it is on /tasks.
    // Windowing the rows as well as the projections would break that — and the
    // asymmetry is the point: a row is a record, a projection is a projection.
    vi.mocked(occurrences.listAll).mockResolvedValue([
      makeRow({ occursOn: "2024-01-01", title: "Ancient" }),
    ]);
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);

    const feed = await listAllFeed(CLAIMS, "2026-03-01", "UTC");
    expect(feed.some((o) => o.title === "Ancient")).toBe(true);
  });

  it("bounds the projections to the window", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([
      makeSeries({ freq: "daily", byweekday: [], startsOn: "2020-01-01" }),
    ]);

    const feed = await listAllFeed(CLAIMS, "2026-03-01", "UTC");
    const days = feed.map((o) => o.occursOn);
    expect(days.every((day) => day >= "2026-01-30" && day <= "2026-04-30")).toBe(
      true,
    );
  });

  it("orders newest day first", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);
    const feed = await listAllFeed(CLAIMS, "2026-01-07", "UTC");
    const days = feed.map((o) => o.occursOn);
    expect([...days].sort().reverse()).toEqual(days);
  });
});

describe("listOverdueFeed", () => {
  const now = new Date("2026-01-08T12:00:00.000Z");

  it("includes a projection whose computed deadline has passed", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);

    const feed = await listOverdueFeed(CLAIMS, "2026-01-08", now, "UTC");

    // Mon 5th and Wed 7th at 09:00 are both behind us; nothing later is.
    expect(feed.map((o) => o.occursOn)).toEqual(["2026-01-05", "2026-01-07"]);
  });

  it("excludes a series with no deadline time, however old — criterion 8", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([
      makeSeries({ deadlineTime: null }),
    ]);

    await expect(
      listOverdueFeed(CLAIMS, "2026-01-08", now, "UTC"),
    ).resolves.toEqual([]);
  });

  it("drops a projection whose row says done — the row wins the merge", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);
    // `listOverdue` returns rows already filtered by the SQL predicate, so a
    // done row is simply absent — and its date must not come back as a
    // projection.
    vi.mocked(occurrences.listOverdue).mockResolvedValue([]);

    const feed = await listOverdueFeed(CLAIMS, "2026-01-08", now, "UTC");
    expect(feed.map((o) => o.occursOn)).toContain("2026-01-05");

    // With the row present and overdue, there is still exactly one entry.
    vi.mocked(occurrences.listOverdue).mockResolvedValue([
      makeRow({
        id: "66666666-6666-4666-8666-666666666666",
        seriesId: SERIES_ID,
        occursOn: "2026-01-05",
        deadlineAt: new Date("2026-01-05T09:00:00.000Z"),
        status: "in_progress",
      }),
    ]);
    const second = await listOverdueFeed(CLAIMS, "2026-01-08", now, "UTC");
    expect(second.filter((o) => o.occursOn === "2026-01-05")).toHaveLength(1);
  });

  it("never projects into the future", async () => {
    vi.mocked(seriesRepo.listActive).mockResolvedValue([makeSeries()]);
    const feed = await listOverdueFeed(CLAIMS, "2026-01-08", now, "UTC");
    expect(feed.every((o) => o.occursOn <= "2026-01-08")).toBe(true);
  });
});

describe("materializeOccurrence", () => {
  const ref = {
    kind: "virtual" as const,
    seriesId: SERIES_ID,
    occursOn: "2026-01-07",
  };

  beforeEach(() => {
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(makeSeries());
    vi.mocked(occurrences.materialize).mockResolvedValue(
      makeRow({ seriesId: SERIES_ID, occursOn: "2026-01-07" }),
    );
  });

  it("writes the row with the series template and the caller's patch", async () => {
    await materializeOccurrence(
      CLAIMS,
      ref,
      { status: "in_progress", progressPct: 60 },
      "UTC",
    );

    expect(occurrences.materialize).toHaveBeenCalledWith(CLAIMS, {
      seriesId: SERIES_ID,
      occursOn: "2026-01-07",
      title: "Team standup",
      description: null,
      deadlineAt: new Date("2026-01-07T09:00:00.000Z"),
      reminderLeadMinutes: null,
      status: "in_progress",
      progressPct: 60,
    });
  });

  it("freezes the computed deadline into the row", async () => {
    // So a later timezone change moves future untouched occurrences and leaves
    // recorded ones where they were — 0004's rule that a stored date is a user
    // intention rather than a derived value.
    await materializeOccurrence(CLAIMS, ref, { status: "done" }, "America/New_York");

    expect(
      vi.mocked(occurrences.materialize).mock.calls[0][1].deadlineAt?.toISOString(),
    ).toBe("2026-01-07T14:00:00.000Z");
  });

  it("seeds the reminder lead from the series when the caller sends none", async () => {
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(
      makeSeries({ reminderLeadMinutes: 60 }),
    );

    await materializeOccurrence(CLAIMS, ref, { progressPct: 40 }, "UTC");

    expect(
      vi.mocked(occurrences.materialize).mock.calls[0][1].reminderLeadMinutes,
    ).toBe(60);
  });

  it("lets the caller's lead win over the template, including switching it off", async () => {
    // `null` is the off switch and must survive the `!== undefined` check —
    // collapsing the two would make "no reminder for just this one" impossible
    // to express on a series that has a template lead.
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(
      makeSeries({ reminderLeadMinutes: 60 }),
    );

    await materializeOccurrence(
      CLAIMS,
      ref,
      { reminderLeadMinutes: null },
      "UTC",
    );

    expect(
      vi.mocked(occurrences.materialize).mock.calls[0][1].reminderLeadMinutes,
    ).toBeNull();
  });

  it("returns null when the series is not the caller's or is deleted", async () => {
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(null);

    await expect(
      materializeOccurrence(CLAIMS, ref, { status: "done" }, "UTC"),
    ).resolves.toBeNull();
    expect(occurrences.materialize).not.toHaveBeenCalled();
  });

  /**
   * Without this, a caller could plant a row belonging to a series on a day that
   * series never names — an occurrence with no rule behind it.
   */
  it("refuses a date the rule does not name", async () => {
    await expect(
      materializeOccurrence(
        CLAIMS,
        { ...ref, occursOn: "2026-01-06" },
        { status: "done" },
        "UTC",
      ),
    ).resolves.toBeNull();
    expect(occurrences.materialize).not.toHaveBeenCalled();
  });

  it("refuses a date past the rule's own end, honouring COUNT from the start", async () => {
    vi.mocked(seriesRepo.findOwn).mockResolvedValue(
      makeSeries({ endsMode: "after", endsCount: 2 }),
    );

    // #1 is Mon 5 Jan, #2 is Wed 7 Jan. There is no #3.
    await expect(
      materializeOccurrence(CLAIMS, ref, { status: "done" }, "UTC"),
    ).resolves.not.toBeNull();

    await expect(
      materializeOccurrence(
        CLAIMS,
        { ...ref, occursOn: "2026-01-12" },
        { status: "done" },
        "UTC",
      ),
    ).resolves.toBeNull();
  });

  it("lets the caller override the title and notes for that one occurrence", async () => {
    await materializeOccurrence(
      CLAIMS,
      ref,
      { title: "Standup (moved room)", description: "In the annexe" },
      "UTC",
    );

    expect(vi.mocked(occurrences.materialize).mock.calls[0][1]).toMatchObject({
      title: "Standup (moved room)",
      description: "In the annexe",
    });
  });
});
