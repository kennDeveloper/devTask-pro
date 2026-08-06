import { describe, expect, it } from "vitest";

import { SERIES_MESSAGES } from "@/lib/tasks/series-validators";

import {
  buildSeriesInput,
  buildSeriesUpdateInput,
  initialSeriesFormValues,
  toRule,
  type SeriesFormValues,
} from "./series-form";

import type { Series, TaskClock } from "./types";

/**
 * The repeat-rule form's payload builders, with no DOM and no tRPC provider.
 *
 * What is asserted is the part this module owns: what gets sent, and which
 * control an error lands on. The rules themselves are `series-validators.ts`'s
 * subject — these builders import those schemas rather than restating them, so
 * a rule can only be changed in one place.
 */

const CLOCK: TaskClock = {
  now: new Date("2026-01-07T15:00:00.000Z"),
  timeZone: "Asia/Manila",
  // A Wednesday. The seeding assertions below turn on that.
  today: "2026-01-07",
};

const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function existing(overrides: Partial<Series> = {}): Series {
  return {
    id: SERIES_ID,
    title: "Team standup",
    description: null,
    startsOn: "2026-01-05",
    deadlineTime: "09:00",
    rule: {
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
    },
    rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function values(overrides: Partial<SeriesFormValues> = {}): SeriesFormValues {
  return { ...initialSeriesFormValues(null, CLOCK), title: "Standup", ...overrides };
}

describe("initialSeriesFormValues", () => {
  it("seeds a new rule from the user's day, never the browser's", () => {
    // A `new Date()` here would seed the browser's day, which differs from the
    // server's for anyone east of it after their evening — and differs between
    // the SSR pass and hydration, which is criterion 19's symptom.
    const seeded = initialSeriesFormValues(null, CLOCK);

    expect(seeded.startsOn).toBe("2026-01-07");
    // The 7th is a Wednesday, so the rule already names a real day.
    expect(seeded.byweekday).toEqual(["WE"]);
    expect(seeded.monthDay).toBe(7);
    expect(seeded.nthWeekday).toBe("WE");
  });

  it("starts weekly, forever, at interval 1", () => {
    expect(initialSeriesFormValues(null, CLOCK)).toMatchObject({
      freq: "weekly",
      interval: 1,
      endsMode: "never",
    });
  });

  it("seeds an edit from the series", () => {
    expect(initialSeriesFormValues(existing(), CLOCK)).toMatchObject({
      title: "Team standup",
      startsOn: "2026-01-05",
      deadlineTime: "09:00",
      freq: "weekly",
      interval: 2,
      byweekday: ["MO", "WE"],
    });
  });

  it("gives every hidden mode a usable value, so switching never empties a control", () => {
    // The monthly and count fields are not on screen for a weekly rule, but the
    // moment the frequency changes they are — with nothing in them unless they
    // were seeded.
    const seeded = initialSeriesFormValues(existing(), CLOCK);
    expect(seeded.monthMode).toBe("by_date");
    expect(seeded.monthDay).toBeGreaterThan(0);
    expect(seeded.nthWeek).toBe(1);
    expect(seeded.endsCount).toBeGreaterThan(0);
  });
});

describe("buildSeriesInput", () => {
  it("nests the rule and sends the series fields flat", () => {
    const result = buildSeriesInput(
      values({ freq: "weekly", interval: 2, byweekday: ["MO", "WE"] }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      title: "Standup",
      startsOn: "2026-01-07",
      rule: { freq: "weekly", interval: 2, byweekday: ["MO", "WE"] },
    });
  });

  it("drops the fields the chosen frequency does not use", () => {
    // The weekdays are still in React state after switching Weekly → Monthly.
    // Sending them would break `task_series_weekly_days_check` in 0005.
    const result = buildSeriesInput(
      values({
        freq: "monthly",
        byweekday: ["MO", "WE"],
        monthMode: "by_date",
        monthDay: 15,
      }),
    );

    expect(result.ok && result.data.rule).toMatchObject({
      byweekday: [],
      monthMode: "by_date",
      monthDay: 15,
      nthWeek: null,
      nthWeekday: null,
    });
  });

  it("sends only the end field the chosen mode uses", () => {
    const on = buildSeriesInput(
      values({ endsMode: "on", endsOn: "2026-12-31", endsCount: 10 }),
    );
    expect(on.ok && on.data.rule).toMatchObject({
      endsOn: "2026-12-31",
      endsCount: null,
    });

    const after = buildSeriesInput(
      values({ endsMode: "after", endsOn: "2026-12-31", endsCount: 10 }),
    );
    expect(after.ok && after.data.rule).toMatchObject({
      endsOn: null,
      endsCount: 10,
    });
  });

  it("treats an empty deadline time as no deadline", () => {
    const result = buildSeriesInput(values({ deadlineTime: "" }));
    expect(result.ok && result.data.deadlineTime).toBeNull();
  });
});

describe("errors land on the control the user has to change", () => {
  it("reports an empty weekday selection under the picker", () => {
    const result = buildSeriesInput(values({ freq: "weekly", byweekday: [] }));

    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.byweekday).toBe(
      SERIES_MESSAGES.weekdaysRequired,
    );
  });

  it("reports a missing end date under the end-date field, not on the form", () => {
    const result = buildSeriesInput(values({ endsMode: "on", endsOn: "" }));

    expect(!result.ok && result.errors.endsOn).toBe(
      SERIES_MESSAGES.endsOnRequired,
    );
    expect(!result.ok && result.errors.form).toBeUndefined();
  });

  it("reports an end date before the start under the end-date field", () => {
    const result = buildSeriesInput(
      values({ startsOn: "2026-06-01", endsMode: "on", endsOn: "2026-01-01" }),
    );

    expect(!result.ok && result.errors.endsOn).toBe(
      SERIES_MESSAGES.endsOnBeforeStart,
    );
  });

  it("reports an out-of-range interval under the interval field", () => {
    const result = buildSeriesInput(values({ interval: 0 }));
    expect(!result.ok && result.errors.interval).toBeTruthy();
  });

  it("reports an empty title under the title field", () => {
    const result = buildSeriesInput(values({ title: "   " }));
    expect(!result.ok && result.errors.title).toBeTruthy();
  });
});

describe("buildSeriesUpdateInput", () => {
  it("sends the whole rule, not a patch of what changed", () => {
    // A rule is one value: `normaliseRule` and `serialize` both take all ten
    // fields together, so a partial rule cannot be normalised without inventing
    // the missing half.
    const result = buildSeriesUpdateInput(
      values({ title: "Renamed" }),
      SERIES_ID,
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      id: SERIES_ID,
      title: "Renamed",
    });
    expect(result.ok && Object.keys(result.data.rule)).toEqual(
      expect.arrayContaining([
        "freq",
        "interval",
        "byweekday",
        "monthMode",
        "monthDay",
        "nthWeek",
        "nthWeekday",
        "endsMode",
        "endsOn",
        "endsCount",
      ]),
    );
  });

  it("applies the same rules as create", () => {
    const result = buildSeriesUpdateInput(
      values({ freq: "monthly", monthMode: "by_nth_weekday" }),
      SERIES_ID,
    );
    // `nthWeek` and `nthWeekday` are seeded, so this one is valid — the point is
    // that the same schema runs.
    expect(result.ok).toBe(true);

    const bad = buildSeriesUpdateInput(
      values({ freq: "weekly", byweekday: [] }),
      SERIES_ID,
    );
    expect(bad.ok).toBe(false);
  });
});

describe("toRule", () => {
  it("produces the value the preview and the list both describe", () => {
    // The editor renders `describeRule(normaliseRule(toRule(values)))` and the
    // list renders the same sentence, so what the editor promises and what the
    // list says cannot drift apart.
    expect(
      toRule(values({ freq: "weekly", interval: 2, byweekday: ["MO", "WE"] })),
    ).toMatchObject({
      freq: "weekly",
      interval: 2,
      byweekday: ["MO", "WE"],
    });
  });

  it("clears monthMode for a non-monthly rule", () => {
    expect(toRule(values({ freq: "daily", monthMode: "by_date" })).monthMode).toBeNull();
  });
});
