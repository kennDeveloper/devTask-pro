import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

import { filterCondition } from "@/lib/db/repos/occurrences";

import {
  hasAnyFilter,
  matchesFilters,
  normaliseFilters,
  type FilterableTask,
  type TaskFilters,
} from "./filters";

/**
 * The filter definition, and the property the whole phase rests on: **its two
 * renderings agree**.
 *
 * Materialised rows are filtered in SQL (`filterCondition`); the occurrences a
 * repeat rule is only projecting are filtered in memory (`matchesFilters`),
 * because they do not exist as rows to filter. If those two ever disagree, a
 * search returns a recurring task on the one day somebody happened to touch it
 * and on no other — and nothing errors, so the user simply concludes they never
 * wrote it down.
 *
 * The same arrangement `overdueCondition`/`isOverdue` have, and phase 2 asserted
 * their agreement on a shared fixture set. This does the same.
 */

const dialect = new PgDialect();

/** The SQL a condition renders to, with placeholders flattened. */
function shape(clause: SQL | undefined): string {
  if (!clause) return "";
  return dialect.sqlToQuery(clause).sql.replace(/\$\d+/g, "?");
}

function task(overrides: Partial<FilterableTask> = {}): FilterableTask {
  return {
    title: "Write the migration",
    occursOn: "2026-08-06",
    status: "todo",
    tags: [],
    ...overrides,
  };
}

const WORK = { id: "11111111-1111-4111-8111-111111111111" };
const URGENT = { id: "22222222-2222-4222-8222-222222222222" };

describe("hasAnyFilter / normaliseFilters", () => {
  it.each([
    ["undefined", undefined],
    ["an empty object", {}],
    ["a whitespace-only search", { search: "   " }],
    ["an empty status list", { statuses: [] }],
    ["an empty tag list", { tagIds: [] }],
  ])("treats %s as no filter at all", (_label, filters) => {
    expect(hasAnyFilter(filters as TaskFilters | undefined)).toBe(false);
    expect(normaliseFilters(filters as TaskFilters | undefined)).toBeUndefined();
  });

  it.each([
    ["a search", { search: "mig" }],
    ["a status", { statuses: ["done" as const] }],
    ["a lower bound", { from: "2026-01-01" }],
    ["an upper bound", { to: "2026-12-31" }],
    ["a tag", { tagIds: [WORK.id] }],
  ])("treats %s as a filter", (_label, filters) => {
    expect(hasAnyFilter(filters)).toBe(true);
    expect(normaliseFilters(filters)).toBe(filters);
  });

  /**
   * Criterion 10, structurally. When nothing is selected the repo composes the
   * byte-identical query phase 3 shipped and the feed skips the in-memory pass —
   * so "clearing every filter returns the unfiltered list" cannot drift.
   */
  it("produces no SQL at all when nothing is filtered", () => {
    expect(filterCondition(undefined)).toBeUndefined();
    expect(filterCondition({})).toBeUndefined();
    expect(filterCondition({ search: "  " })).toBeUndefined();
  });
});

describe("search", () => {
  it("matches a substring, case-insensitively", () => {
    expect(matchesFilters(task(), { search: "MIGRA" })).toBe(true);
    expect(matchesFilters(task(), { search: "migration" })).toBe(true);
    expect(matchesFilters(task(), { search: "rollback" })).toBe(false);
  });

  it("matches mid-word, which is what a three-letter search expects", () => {
    // The reason this is `ilike` and not full-text: a stemming index would not
    // match "igra" and the user typing it has no way to know why.
    expect(matchesFilters(task(), { search: "igra" })).toBe(true);
  });

  it("renders to an ilike, and escapes a user's wildcards", () => {
    // Without escaping, searching for "50%" matches every task and "a_b"
    // matches "axb".
    expect(shape(filterCondition({ search: "50%" }))).toContain("ilike");
    const query = dialect.sqlToQuery(filterCondition({ search: "50%" })!);
    expect(query.params[0]).toBe("%50\\%%");
  });

  it("treats a term as literal text in both halves", () => {
    // The pure half uses `includes`, not a RegExp — a term with `(` or `*` would
    // otherwise throw or quietly become a different pattern.
    expect(matchesFilters(task({ title: "Ship v1 (finally)" }), { search: "(finally)" })).toBe(
      true,
    );
  });
});

describe("status", () => {
  it("is OR-ed within", () => {
    const filters = { statuses: ["todo" as const, "done" as const] };
    expect(matchesFilters(task({ status: "todo" }), filters)).toBe(true);
    expect(matchesFilters(task({ status: "done" }), filters)).toBe(true);
    expect(matchesFilters(task({ status: "in_progress" }), filters)).toBe(false);
  });

  it("renders to an `in` list", () => {
    expect(shape(filterCondition({ statuses: ["todo", "done"] }))).toContain(
      "in (",
    );
  });
});

describe("date range", () => {
  it("is inclusive at both ends", () => {
    const filters = { from: "2026-08-06", to: "2026-08-06" };
    expect(matchesFilters(task({ occursOn: "2026-08-06" }), filters)).toBe(true);
    expect(matchesFilters(task({ occursOn: "2026-08-05" }), filters)).toBe(false);
    expect(matchesFilters(task({ occursOn: "2026-08-07" }), filters)).toBe(false);
  });

  it("accepts an open-ended range in either direction", () => {
    expect(matchesFilters(task(), { from: "2026-01-01" })).toBe(true);
    expect(matchesFilters(task(), { to: "2026-12-31" })).toBe(true);
  });

  it("renders to >= and <= on occurs_on", () => {
    const sql = shape(filterCondition({ from: "2026-01-01", to: "2026-12-31" }));
    expect(sql).toContain('"occurs_on" >=');
    expect(sql).toContain('"occurs_on" <=');
  });
});

describe("tags", () => {
  it("is OR-ed within — any one of them is enough", () => {
    const filters = { tagIds: [WORK.id, URGENT.id] };
    expect(matchesFilters(task({ tags: [WORK] }), filters)).toBe(true);
    expect(matchesFilters(task({ tags: [URGENT] }), filters)).toBe(true);
    expect(matchesFilters(task({ tags: [WORK, URGENT] }), filters)).toBe(true);
    expect(matchesFilters(task({ tags: [] }), filters)).toBe(false);
  });

  /**
   * `exists`, not a join. A join would return one row per matching tag, so a
   * task carrying two of the selected tags would appear twice — and the fix for
   * that would have to be remembered by every caller.
   */
  it("renders to an EXISTS rather than a join", () => {
    const sql = shape(filterCondition({ tagIds: [WORK.id, URGENT.id] }));
    expect(sql).toContain("exists");
    expect(sql).toContain("occurrence_tags");
  });
});

describe("filters compose", () => {
  it("AND-s across fields", () => {
    const filters: TaskFilters = {
      search: "migration",
      statuses: ["todo"],
      from: "2026-08-01",
      to: "2026-08-31",
      tagIds: [WORK.id],
    };

    expect(matchesFilters(task({ tags: [WORK] }), filters)).toBe(true);
    // Each one alone is enough to exclude it.
    expect(matchesFilters(task({ tags: [WORK], title: "Other" }), filters)).toBe(false);
    expect(matchesFilters(task({ tags: [WORK], status: "done" }), filters)).toBe(false);
    expect(
      matchesFilters(task({ tags: [WORK], occursOn: "2026-09-01" }), filters),
    ).toBe(false);
    expect(matchesFilters(task({ tags: [URGENT] }), filters)).toBe(false);
  });

  it("renders every selected field into the SQL", () => {
    const sql = shape(
      filterCondition({
        search: "migration",
        statuses: ["todo"],
        from: "2026-08-01",
        to: "2026-08-31",
        tagIds: [WORK.id],
      }),
    );

    expect(sql).toContain("ilike");
    expect(sql).toContain("in (");
    expect(sql).toContain('"occurs_on" >=');
    expect(sql).toContain('"occurs_on" <=');
    expect(sql).toContain("exists");
  });
});

/**
 * ===========================================================================
 * THE AGREEMENT
 * ===========================================================================
 *
 * The two halves cannot be run against each other without a database, so what
 * is asserted here is the property that is checkable without one: **whenever the
 * pure predicate has an opinion, the SQL half has one too, and vice versa.**
 * A field that filtered projections but produced no SQL — or the reverse — is
 * exactly the drift that makes a recurring task invisible to a search, and it is
 * the shape a future edit is most likely to introduce.
 *
 * `tests/integration/tags.test.ts` closes the loop by running the same fixtures
 * through a real Postgres.
 */
describe("the SQL and pure halves stay in step", () => {
  const everyFilter: Array<[string, TaskFilters]> = [
    ["search", { search: "migration" }],
    ["status", { statuses: ["todo"] }],
    ["from", { from: "2026-01-01" }],
    ["to", { to: "2026-12-31" }],
    ["tags", { tagIds: [WORK.id] }],
  ];

  it.each(everyFilter)(
    "%s produces SQL and is capable of excluding a task",
    (_label, filters) => {
      // The SQL half has an opinion…
      expect(filterCondition(filters)).toBeDefined();

      // …and so does the pure half: there is some task it rejects.
      const excluded = [
        task({ title: "nothing alike" }),
        task({ status: "done" }),
        task({ occursOn: "1999-01-01" }),
        task({ occursOn: "2099-01-01" }),
        task({ tags: [URGENT] }),
      ].some((candidate) => !matchesFilters(candidate, filters));

      expect(excluded).toBe(true);
    },
  );

  it("both halves are inert for the same inputs", () => {
    for (const inert of [undefined, {}, { search: "   " }, { statuses: [] }]) {
      const filters = inert as TaskFilters | undefined;
      expect(filterCondition(filters)).toBeUndefined();
      // A task that matches nothing in particular still passes.
      expect(matchesFilters(task({ title: "anything" }), filters)).toBe(true);
    }
  });
});
