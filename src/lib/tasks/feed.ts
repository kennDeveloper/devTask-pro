import * as occurrences from "@/lib/db/repos/occurrences";
import * as seriesRepo from "@/lib/db/repos/series";
import * as tagsRepo from "@/lib/db/repos/tags";
import type { UserClaims } from "@/lib/db/rls";
import type { Tag, TaskOccurrence, TaskSeries, TaskStatus } from "@/lib/db/schema";
import { parseIsoDate } from "@/lib/recurrence/calendar";
import { expand } from "@/lib/recurrence/expand";
import type { RecurrenceRule } from "@/lib/recurrence/rule";
import { addDaysToIsoDate, instantFromWallClock } from "@/lib/time/day-boundary";

import { matchesFilters, normaliseFilters, type TaskFilters } from "./filters";
import { isOverdue } from "./overdue";
import {
  virtualOccurrenceId,
  type VirtualOccurrenceRef,
} from "./occurrence-ref";

/**
 * The occurrence feed: what a list actually shows once recurrence exists.
 *
 * ============================================================================
 * READS EXPAND VIRTUALLY. NOTHING HERE WRITES DURING A GET.
 * ============================================================================
 *
 * A list is the union of two things:
 *
 *   - **materialised rows** — `task_occurrence`, which exist because somebody
 *     touched that date;
 *   - **virtual occurrences** — dates a live series names that nobody has
 *     touched, built in memory from the rule.
 *
 * They are merged on `(series_id, occurs_on)`, with the row winning. That single
 * sentence is most of the phase:
 *
 *   - Setting occurrence #3 to `in_progress` writes one row and leaves #1, #2
 *     and #4 as projections (**criterion 14**).
 *   - Editing the rule writes nothing: untouched occurrences were never rows and
 *     simply move, while touched ones are rows and keep what they carry —
 *     including on a date the new rule no longer names, where they still appear
 *     because the merge is a *union* and not a filter (**criterion 15**).
 *   - Deleting a series soft-deletes it, so it stops being expanded and its
 *     untouched future vanishes, while its rows survive (**criterion 17**).
 *
 * ## The window, and why only one side of the merge has one
 *
 * A series with `ends_mode = never` names infinitely many dates, so the virtual
 * side must be bounded. Materialised rows are **not** windowed: a row exists
 * because a person acted on it and must not disappear from `/tasks` because it
 * aged out of a range — phase 2's own e2e seeds a task 400 days back and asserts
 * it is visible. The bound belongs on the projection, not on the record.
 *
 * The window is derived from the server-resolved day (`currentUserClock()`), so
 * nothing under `src/components/**` decides what range is on screen any more
 * than it decides what day it is — that is criterion 19 applied to a range.
 */

/**
 * How far back a list projects untouched occurrences.
 *
 * A month is about as much missed recurring work as anyone wants nagging them,
 * and it guarantees at least one occurrence of a monthly series is in view.
 */
export const FEED_WINDOW_BACK_DAYS = 30;

/**
 * How far forward.
 *
 * Two months rather than a quarter because `task.list` is still unpaginated (see
 * the note on `occurrences.listAll`): a daily series over 90 days is 90 rows
 * before anything else is on the page. This buys time for a cursor; it does not
 * replace one.
 */
export const FEED_WINDOW_FORWARD_DAYS = 60;

/** The `[from, to]` calendar range one view projects over. Both inclusive. */
export interface FeedWindow {
  from: string;
  to: string;
}

/** Which list is asking. Each has a different reach, for a different reason. */
export type FeedView = "day" | "all" | "overdue";

/**
 * The range to project for a view, given the account holder's today.
 *
 * - `day` is exactly the day being viewed — `/today` shows one calendar square.
 * - `all` reaches both ways; it is the "what did I write down" screen.
 * - `overdue` reaches backwards only. An occurrence in the future cannot be
 *   late, so projecting one would be work whose every result is discarded.
 */
export function feedWindow(view: FeedView, today: string): FeedWindow {
  switch (view) {
    case "day":
      return { from: today, to: today };
    case "overdue":
      return { from: addDaysToIsoDate(today, -FEED_WINDOW_BACK_DAYS), to: today };
    case "all":
      return {
        from: addDaysToIsoDate(today, -FEED_WINDOW_BACK_DAYS),
        to: addDaysToIsoDate(today, FEED_WINDOW_FORWARD_DAYS),
      };
  }
}

/**
 * One row of a list, whether or not it is a row in the database.
 *
 * Structurally a `TaskOccurrence` plus `virtual`, so `toPublicTask` serialises
 * both kinds through one function and the client's `Task` type does not have to
 * grow a union. `id` is either a real uuid or the synthetic
 * `series:<uuid>:<date>` reference — see `./occurrence-ref.ts` for why that
 * beats a nullable id.
 */
export interface ListedOccurrence {
  id: string;
  seriesId: string | null;
  title: string;
  description: string | null;
  occursOn: string;
  deadlineAt: Date | null;
  status: TaskStatus;
  progressPct: number;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** True when this is a projection of a rule rather than a stored row. */
  virtual: boolean;
  /**
   * The labels on this occurrence.
   *
   * A row carries its own, written when it materialised. A projection carries
   * its **series'** template tags, resolved by the feed — so the filter, the
   * row, the card and `toPublicTask` all treat the two identically and no
   * component above this file has to know which kind it is looking at.
   */
  tags: Tag[];
}

/** `ownerId -> tags`, built once per read from one flat join query. */
export function groupTags(
  links: ReadonlyArray<{ ownerId: string; tag: Tag }>,
): Map<string, Tag[]> {
  const grouped = new Map<string, Tag[]>();

  for (const { ownerId, tag } of links) {
    const existing = grouped.get(ownerId);
    if (existing) existing.push(tag);
    else grouped.set(ownerId, [tag]);
  }

  return grouped;
}

/** The rule columns of a series row, as the engine's own type. */
export function ruleFromSeries(series: TaskSeries): RecurrenceRule {
  return {
    freq: series.freq,
    interval: series.interval,
    byweekday: series.byweekday,
    monthMode: series.monthMode,
    monthDay: series.monthDay,
    nthWeek: series.nthWeek,
    nthWeekday: series.nthWeekday,
    endsMode: series.endsMode,
    endsOn: series.endsOn,
    endsCount: series.endsCount,
  };
}

/**
 * The instant an occurrence of `series` on `occursOn` becomes late.
 *
 * **This is acceptance criterion 20.** The series stores a wall-clock
 * `deadline_time` with no zone, and the instant is resolved *per date* in the
 * account holder's timezone — so 09:00 is 09:00 local on both sides of a DST
 * transition, rather than drifting by an hour for half the year the way a stored
 * instant plus a fixed 24-hour multiple would.
 *
 * `null` when the series has no deadline time, and a NULL `deadline_at` is never
 * `< now()` — so such occurrences are never overdue, however old they get
 * (criterion 8, inherited unchanged from phase 2).
 */
export function occurrenceDeadline(
  series: TaskSeries,
  occursOn: string,
  timeZone: string,
): Date | null {
  if (!series.deadlineTime) return null;

  const date = parseIsoDate(occursOn);
  if (!date) return null;

  // Postgres reads a `time` column back as `HH:MM:SS`; the editor sends `HH:MM`.
  const [hour, minute] = series.deadlineTime.split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  return instantFromWallClock(timeZone, date, hour, minute);
}

/** A stored row as a list entry. */
export function fromRow(row: TaskOccurrence, tags: Tag[] = []): ListedOccurrence {
  return {
    id: row.id,
    seriesId: row.seriesId,
    title: row.title,
    description: row.description,
    occursOn: row.occursOn,
    deadlineAt: row.deadlineAt,
    status: row.status,
    progressPct: row.progressPct,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    virtual: false,
    tags,
  };
}

/**
 * One projected occurrence of a series.
 *
 * `status` and `progressPct` are the column defaults from 0004 rather than
 * anything stored, because by definition nobody has touched this date. The
 * timestamps are the series' own: a projection has no creation time of its own,
 * and inventing `new Date()` here would make the value differ between the SSR
 * pass and any later render — the class of bug criterion 19 is about.
 */
export function fromSeries(
  series: TaskSeries,
  occursOn: string,
  timeZone: string,
  tags: Tag[] = [],
): ListedOccurrence {
  return {
    id: virtualOccurrenceId(series.id, occursOn),
    seriesId: series.id,
    title: series.title,
    description: series.description,
    occursOn,
    deadlineAt: occurrenceDeadline(series, occursOn, timeZone),
    status: "todo",
    progressPct: 0,
    completedAt: null,
    createdAt: series.createdAt,
    updatedAt: series.updatedAt,
    virtual: true,
    tags,
  };
}

/** Every date `series` names inside `window`, as projected occurrences. */
export function seriesOccurrences(
  series: TaskSeries,
  window: FeedWindow,
  timeZone: string,
  tags: Tag[] = [],
): ListedOccurrence[] {
  return expand(ruleFromSeries(series), series.startsOn, window).map((day) =>
    fromSeries(series, day, timeZone, tags),
  );
}

/** The merge key. One-off rows carry `series_id IS NULL` and never collide. */
function occurrenceKey(entry: {
  seriesId: string | null;
  occursOn: string;
}): string | null {
  return entry.seriesId ? `${entry.seriesId}|${entry.occursOn}` : null;
}

/**
 * Rows and projections as one list, **rows winning**.
 *
 * A union rather than a filter, and that is the load-bearing choice. Filtering
 * the rows down to dates the current rule still names would quietly drop a row
 * whose date the rule stopped naming after an edit — which is exactly the row
 * acceptance criterion 15 says must keep its status and progress. Here it simply
 * appears, as itself, on the day the work was recorded against.
 */
export function mergeOccurrences(
  rows: readonly ListedOccurrence[],
  virtual: readonly ListedOccurrence[],
): ListedOccurrence[] {
  const taken = new Set(
    rows.map(occurrenceKey).filter((key): key is string => key !== null),
  );

  return [
    ...rows,
    ...virtual.filter((entry) => {
      const key = occurrenceKey(entry);
      return key === null || !taken.has(key);
    }),
  ];
}

/**
 * Order within one day: timed work first, in the order it comes due.
 *
 * Mirrors the `orderBy` in `occurrences.listForDay` — the projections have to
 * slot into the same sequence the rows were already in, or a series occurrence
 * would land at the bottom of a day regardless of its deadline. `title` is the
 * final tiebreak so the list does not reshuffle between two renders of the same
 * data, which `created_at` cannot guarantee once projections share a series'
 * timestamp.
 */
function byDeadlineThenTitle(a: ListedOccurrence, b: ListedOccurrence): number {
  const left = a.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const right = b.deadlineAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.title.localeCompare(b.title);
}

/** Newest day first, then as within a day. Mirrors `occurrences.listAll`. */
function byDayDescending(a: ListedOccurrence, b: ListedOccurrence): number {
  if (a.occursOn !== b.occursOn) return a.occursOn < b.occursOn ? 1 : -1;
  return byDeadlineThenTitle(a, b);
}

/**
 * Every tag on the page, in **two** queries.
 *
 * One for the rows and one for the series, regardless of how many occurrences
 * are on screen — a daily series over a 91-day window is 91 projections and
 * still one query, because they all share a rule. Resolving tags per occurrence
 * instead would make a list read N+1 in the most literal way.
 *
 * Both run in a **single** `withUser()`: the transaction, not the statement, is
 * what costs. See `tagsForFeed`.
 */
async function loadTags(
  claims: UserClaims,
  rows: readonly TaskOccurrence[],
  live: readonly TaskSeries[],
): Promise<{ rowTags: Map<string, Tag[]>; seriesTags: Map<string, Tag[]> }> {
  const { occurrenceLinks, seriesLinks } = await tagsRepo.tagsForFeed(
    claims,
    rows.map((row) => row.id),
    live.map((series) => series.id),
  );

  return {
    rowTags: groupTags(occurrenceLinks),
    seriesTags: groupTags(seriesLinks),
  };
}

// ---------------------------------------------------------------------------
// The three reads
// ---------------------------------------------------------------------------
//
// Each does the same three things — read the live series, read the materialised
// rows, merge — and differs only in the window and the ordering. They live here
// rather than in the router because AGENTS.md puts business logic in
// `src/lib/**` and because the router should not be the place that knows a list
// is two queries.

/** Everything the caller owns dated `day`, rows and projections alike. */
export async function listDayFeed(
  claims: UserClaims,
  day: string,
  timeZone: string,
  filters?: TaskFilters,
): Promise<ListedOccurrence[]> {
  const active = normaliseFilters(filters);

  const [rows, live] = await Promise.all([
    occurrences.listForDay(claims, day, active),
    seriesRepo.listActive(claims),
  ]);

  const { rowTags, seriesTags } = await loadTags(claims, rows, live);

  const window = feedWindow("day", day);
  const virtual = live
    .flatMap((series) =>
      seriesOccurrences(series, window, timeZone, seriesTags.get(series.id) ?? []),
    )
    .filter((entry) => matchesFilters(entry, active));

  return mergeOccurrences(
    rows.map((row) => fromRow(row, rowTags.get(row.id) ?? [])),
    virtual,
  ).sort(byDeadlineThenTitle);
}

/**
 * Everything the caller owns, newest day first.
 *
 * Rows are unwindowed (every task ever), projections are windowed — see the
 * module header. A one-off from last year is still here; a daily series is not
 * projected back to its start.
 */
export async function listAllFeed(
  claims: UserClaims,
  today: string,
  timeZone: string,
  filters?: TaskFilters,
): Promise<ListedOccurrence[]> {
  const active = normaliseFilters(filters);

  const [rows, live] = await Promise.all([
    occurrences.listAll(claims, active),
    seriesRepo.listActive(claims),
  ]);

  const { rowTags, seriesTags } = await loadTags(claims, rows, live);

  const window = feedWindow("all", today);
  const virtual = live
    .flatMap((series) =>
      seriesOccurrences(series, window, timeZone, seriesTags.get(series.id) ?? []),
    )
    .filter((entry) => matchesFilters(entry, active));

  return mergeOccurrences(
    rows.map((row) => fromRow(row, rowTags.get(row.id) ?? [])),
    virtual,
  ).sort(byDayDescending);
}

/**
 * The derived overdue bucket, across both kinds.
 *
 * The rows come back already filtered by `overdueCondition` — the SQL half of
 * the definition. The projections are judged by `isOverdue`, the TypeScript
 * half. AGENTS.md requires those two to be changed together, and this is the one
 * function that depends on them agreeing; `overdue.test.ts` asserts they do on a
 * shared fixture set.
 */
export async function listOverdueFeed(
  claims: UserClaims,
  today: string,
  now: Date,
  timeZone: string,
  filters?: TaskFilters,
): Promise<ListedOccurrence[]> {
  const active = normaliseFilters(filters);

  const [rows, live] = await Promise.all([
    occurrences.listOverdue(claims, now, active),
    seriesRepo.listActive(claims),
  ]);

  const { rowTags, seriesTags } = await loadTags(claims, rows, live);

  const window = feedWindow("overdue", today);
  const virtual = live
    .flatMap((series) =>
      seriesOccurrences(series, window, timeZone, seriesTags.get(series.id) ?? []),
    )
    .filter((entry) => isOverdue(entry, now) && matchesFilters(entry, active));

  return mergeOccurrences(
    rows.map((row) => fromRow(row, rowTags.get(row.id) ?? [])),
    virtual,
  ).sort(byDeadlineThenTitle);
}

// ---------------------------------------------------------------------------
// Materialisation — the only write in this module
// ---------------------------------------------------------------------------

/** What a first touch may set. `occursOn` is absent on purpose — see below. */
export interface TouchOccurrencePatch {
  title?: string;
  description?: string | null;
  deadlineAt?: Date | null;
  status?: TaskStatus;
  progressPct?: number;
}

/**
 * Turn a projection into a row, because somebody touched it.
 *
 * Returns `null` when the series is not the caller's, has been deleted, or does
 * not name that date — all three are `NOT_FOUND` to the caller, because from
 * outside they are the same fact.
 *
 * ## Why the date is re-checked against the rule
 *
 * The reference arrives from the client, and without this a caller could
 * materialise an occurrence on any date at all — a row belonging to a series on
 * a day that series never names. `expand()` over a single-day window is the
 * check, and it is exact rather than approximate: the walk still starts at
 * `starts_on`, so `COUNT` and `UNTIL` are honoured and the last occurrence of a
 * `COUNT=10` series cannot be followed by an eleventh.
 *
 * ## Why `occursOn` is not in the patch
 *
 * Moving a projected occurrence to a different day would create a row on a date
 * the rule does not name — the same thing the check above exists to prevent,
 * arriving through the front door. The day of a recurring occurrence belongs to
 * the rule, and the editor disables that control for one. A *materialised*
 * occurrence can still be moved through `task.update`, which is the ordinary
 * row path.
 */
export async function materializeOccurrence(
  claims: UserClaims,
  ref: VirtualOccurrenceRef,
  patch: TouchOccurrencePatch,
  timeZone: string,
): Promise<TaskOccurrence | null> {
  const series = await seriesRepo.findOwn(claims, ref.seriesId);
  if (!series) return null;

  const named = expand(ruleFromSeries(series), series.startsOn, {
    from: ref.occursOn,
    to: ref.occursOn,
  });
  if (named.length === 0) return null;

  const row = await occurrences.materialize(claims, {
    seriesId: series.id,
    occursOn: ref.occursOn,
    // The template, overridable by whatever the caller actually sent.
    title: patch.title ?? series.title,
    description:
      patch.description !== undefined ? patch.description : series.description,
    deadlineAt:
      patch.deadlineAt !== undefined
        ? patch.deadlineAt
        : occurrenceDeadline(series, ref.occursOn, timeZone),
    status: patch.status,
    progressPct: patch.progressPct,
  });

  await copyTemplateTags(claims, series.id, row.id);

  return row;
}

/**
 * Copy a series' template tags onto a freshly materialised occurrence — **once**.
 *
 * "Once" is what the emptiness check buys. The upsert above runs on every touch,
 * so re-copying would undo somebody who had removed a tag from this one
 * occurrence — the same reasoning that stops the upsert resetting `status` and
 * `progress_pct` from the template, and the same rule every other series field
 * follows: the template seeds the occurrence and then lets go of it.
 *
 * It is a separate statement rather than part of the insert because
 * `occurrence_tags` has a composite foreign key onto `(id, user_id)` and there is
 * nothing to point at until the row exists.
 */
async function copyTemplateTags(
  claims: UserClaims,
  seriesId: string,
  occurrenceId: string,
): Promise<void> {
  const alreadyTagged = await tagsRepo.tagsForOccurrences(claims, [
    occurrenceId,
  ]);
  if (alreadyTagged.length > 0) return;

  const template = await tagsRepo.tagsForSeries(claims, [seriesId]);
  if (template.length === 0) return;

  await tagsRepo.setForOccurrence(
    claims,
    occurrenceId,
    template.map((link) => link.tag.id),
  );
}
