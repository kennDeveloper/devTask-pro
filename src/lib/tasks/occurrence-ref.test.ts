import { describe, expect, it } from "vitest";

import {
  isVirtualOccurrenceId,
  occurrenceRefField,
  parseOccurrenceRef,
  virtualOccurrenceId,
} from "./occurrence-ref";

const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ROW_ID = "33333333-3333-4333-8333-333333333333";

describe("virtual occurrence ids", () => {
  it("round-trips a series and a day", () => {
    const id = virtualOccurrenceId(SERIES_ID, "2026-08-06");
    expect(parseOccurrenceRef(id)).toEqual({
      kind: "virtual",
      seriesId: SERIES_ID,
      occursOn: "2026-08-06",
    });
  });

  it("is deterministic, so it is a stable React key across renders", () => {
    expect(virtualOccurrenceId(SERIES_ID, "2026-08-06")).toBe(
      virtualOccurrenceId(SERIES_ID, "2026-08-06"),
    );
  });

  it("is readable in a data attribute or a failing assertion", () => {
    expect(virtualOccurrenceId(SERIES_ID, "2026-08-06")).toBe(
      `series:${SERIES_ID}:2026-08-06`,
    );
  });

  it("is distinguishable from a row id without parsing", () => {
    expect(isVirtualOccurrenceId(virtualOccurrenceId(SERIES_ID, "2026-08-06"))).toBe(
      true,
    );
    expect(isVirtualOccurrenceId(ROW_ID)).toBe(false);
  });
});

describe("parseOccurrenceRef", () => {
  it("reads a plain uuid as a row", () => {
    expect(parseOccurrenceRef(ROW_ID)).toEqual({ kind: "row", id: ROW_ID });
  });

  it.each([
    ["an empty string", ""],
    ["a non-uuid", "task-123"],
    ["a uuid with a typo", "33333333-3333-4333-8333-33333333333"],
    ["a virtual ref with no date", `series:${SERIES_ID}`],
    ["a virtual ref with a bad series id", "series:not-a-uuid:2026-08-06"],
    ["a virtual ref with a date that does not exist", `series:${SERIES_ID}:2026-02-31`],
    ["a virtual ref with an unpadded date", `series:${SERIES_ID}:2026-8-6`],
    ["a virtual ref with nothing at all", "series:"],
  ])("returns null for %s", (_label, value) => {
    expect(parseOccurrenceRef(value)).toBeNull();
  });

  it("rejects an impossible date rather than letting Postgres do it", () => {
    // A 400 naming the field beats a 500 carrying a driver message.
    expect(parseOccurrenceRef(`series:${SERIES_ID}:2026-02-30`)).toBeNull();
  });
});

describe("occurrenceRefField", () => {
  it("accepts both kinds", () => {
    expect(occurrenceRefField.safeParse(ROW_ID).success).toBe(true);
    expect(
      occurrenceRefField.safeParse(virtualOccurrenceId(SERIES_ID, "2026-08-06"))
        .success,
    ).toBe(true);
  });

  it("rejects anything else with a message rather than a Zod default", () => {
    const result = occurrenceRefField.safeParse("nope");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toMatch(/not valid/i);
  });
});
