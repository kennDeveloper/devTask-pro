/**
 * Search and filter, defined once and rendered in two languages.
 *
 * ============================================================================
 * EVERY FILTER IS EVALUATED ON BOTH HALVES OF THE FEED.
 * ============================================================================
 *
 * A list is materialised rows plus projections of a repeat rule (see
 * `./feed.ts`). Rows are filtered in SQL; projections are filtered in memory,
 * because they do not exist as rows to filter. So each rule needs two renderings
 * — and they have to agree, or a search would return a recurring task on the day
 * somebody happened to touch it and not on any other.
 *
 * That is exactly the arrangement `overdueCondition` (SQL) and `isOverdue`
 * (TypeScript) already have, and `AGENTS.md` already requires those two to be
 * changed together. The same rule applies here: **`matchesFilters` below and
 * `filterCondition` in `src/lib/db/repos/occurrences.ts` are two halves of one
 * definition.** `filters.test.ts` asserts they agree on a shared fixture set.
 *
 * The silent failure this guards against is the worst kind: nothing errors, the
 * list is simply missing the thing the user was looking for, and they conclude
 * they never wrote it down.
 */

import type { TaskStatus } from "@/lib/db/schema";

/**
 * What a user has asked to see.
 *
 * Every field is optional and every absent field means "no opinion". Filters are
 * **AND-ed across** fields — a search *and* a status *and* a range — while
 * `statuses` and `tagIds` are **OR-ed within**: picking Work and Urgent shows
 * tasks carrying either, which is what every tool with this control does.
 */
export interface TaskFilters {
  /** Matched against the title, case-insensitively, as a substring. */
  search?: string;
  /** Any of these statuses. Empty or absent means all of them. */
  statuses?: readonly TaskStatus[];
  /** Inclusive lower bound on `occurs_on`, as `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound on `occurs_on`, as `YYYY-MM-DD`. */
  to?: string;
  /** Any of these tag ids. Empty or absent means "do not filter by tag". */
  tagIds?: readonly string[];
}

/** The fields `matchesFilters` reads, and nothing else. */
export interface FilterableTask {
  title: string;
  occursOn: string;
  status: TaskStatus;
  tags: ReadonlyArray<{ id: string }>;
}

/**
 * Whether anything is actually being filtered.
 *
 * The point is not tidiness. When this is false the repo issues the byte-identical
 * query phase 3 shipped and the feed skips the in-memory pass entirely — so
 * "clearing every filter returns exactly the unfiltered list" (criterion 10) is
 * structural rather than a behaviour that could drift.
 *
 * A whitespace-only search is not a search. Someone who types a space and deletes
 * it should not get a different list from someone who never typed.
 */
export function hasAnyFilter(filters: TaskFilters | undefined): boolean {
  if (!filters) return false;

  return Boolean(
    filters.search?.trim() ||
      (filters.statuses && filters.statuses.length > 0) ||
      filters.from ||
      filters.to ||
      (filters.tagIds && filters.tagIds.length > 0),
  );
}

/**
 * `filters`, or `undefined` when they amount to nothing.
 *
 * Callers pass the result straight through, so there is one place that decides
 * what "no filter" means rather than a `hasAnyFilter` check at every call site
 * that could be forgotten at one of them.
 */
export function normaliseFilters(
  filters: TaskFilters | undefined,
): TaskFilters | undefined {
  return hasAnyFilter(filters) ? filters : undefined;
}

/**
 * Case-insensitive substring match — the TypeScript half of SQL's
 * `ilike '%term%'`.
 *
 * `toLowerCase()` on both sides rather than a `RegExp`: the search term is user
 * input, and a term containing `(` or `*` would either throw or quietly become a
 * pattern that matches something else.
 */
function matchesSearch(title: string, search: string): boolean {
  return title.toLowerCase().includes(search.trim().toLowerCase());
}

/**
 * Whether one occurrence — row or projection — survives the filters.
 *
 * The TypeScript half of the definition. Its SQL twin is `filterCondition` in
 * `src/lib/db/repos/occurrences.ts`; change them together.
 */
export function matchesFilters(
  task: FilterableTask,
  filters: TaskFilters | undefined,
): boolean {
  if (!hasAnyFilter(filters) || !filters) return true;

  const search = filters.search?.trim();
  if (search && !matchesSearch(task.title, search)) return false;

  if (filters.statuses?.length && !filters.statuses.includes(task.status)) {
    return false;
  }

  // String comparison is correct for zero-padded `YYYY-MM-DD`, and both bounds
  // are inclusive — the same half-open-vs-closed question `dayRangeInZone`
  // answers for instants does not arise for calendar squares.
  if (filters.from && task.occursOn < filters.from) return false;
  if (filters.to && task.occursOn > filters.to) return false;

  if (filters.tagIds?.length) {
    const wanted = new Set(filters.tagIds);
    // OR within the tag filter: any one of them is enough.
    if (!task.tags.some((tag) => wanted.has(tag.id))) return false;
  }

  return true;
}
