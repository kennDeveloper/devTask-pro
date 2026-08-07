import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";

import { withUser, type UserClaims } from "@/lib/db/rls";
import {
  occurrenceTags,
  taskOccurrence,
  type TaskOccurrence,
  type TaskStatus,
} from "@/lib/db/schema";
import { hasAnyFilter, type TaskFilters } from "@/lib/tasks/filters";

/**
 * The `task_occurrence` repository — the only module that speaks Drizzle about tasks.
 *
 * ============================================================================
 * EVERY FUNCTION HERE OPENS ITS OWN `withUser()`. `dbAdmin` DOES NOT APPEAR.
 * ============================================================================
 *
 * `AGENTS.md` puts one repo module per table under `src/lib/db/repos/` and has routers
 * call the repo rather than Drizzle. On this table that convention is doing security
 * work, not tidiness work. `task_occurrence` holds the data the product promise is
 * about — "nobody sees anybody else's tasks, including admins" — so the number of
 * places that can compose a query against it should be one, and it should be a place
 * that is read as a unit when the guarantee is audited. A router reaching for
 * `tx.select().from(taskOccurrence)` directly is not wrong today; it is a second place
 * that has to keep being right, and `dbAdmin` is one import line away from it.
 *
 * Intended call style is a namespace import, because several of these names are
 * deliberately generic:
 *
 * ```ts
 * import * as occurrences from "@/lib/db/repos/occurrences";
 * const rows = await occurrences.listForDay({ sub: ctx.user.id }, "2026-08-06");
 * ```
 *
 * Three rules the implementations below all follow, each for a reason worth stating:
 *
 * 1. **`claims` first, and the caller never supplies a `userId`.** `create()` takes the
 *    owner from `claims.sub`. There is no input field for it, so "create a task in
 *    someone else's list" is not an operation this module can express. The RLS
 *    `with check` in 0004 would reject it anyway — this just means the attempt never
 *    reaches the database as a plausible-looking one.
 *
 * 2. **Explicit `.where()` on `user_id` even though RLS already scopes the row set.**
 *    The reasoning is the one spelled out in `profile.ts`: RLS makes the clause
 *    redundant, not the habit. A repo whose queries read as unbounded is the template
 *    the next table gets written from, and the next table may be added before its
 *    policies are. It also keeps the `(user_id, ...)`-leading indexes in 0004 obviously
 *    applicable at the call site rather than only via the policy's injected predicate.
 *
 * 3. **`completed_at` and `updated_at` are never written here.** Both are maintained by
 *    triggers in 0004 (`sync_task_completed_at`, `task_occurrence_touch_updated_at`).
 *    Setting either from application code does not "help" — it competes with a BEFORE
 *    trigger that will overwrite it, and leaves a reader unsure which one is authoritative.
 */

/**
 * The overdue predicate. **This is the only definition of "overdue" in the codebase.**
 *
 * Overdue is derived at read time, never stored (0004 explains why at length), which
 * means the predicate itself is the specification. Exporting it — rather than letting
 * the router, a future dashboard count and the tests each re-type the same three
 * conditions — is what keeps "overdue" one concept. A second, subtly different copy
 * (say, one that forgets `status <> 'done'`) would not fail any test; it would just
 * quietly disagree with the /overdue page.
 *
 * `deadline_at is not null` is redundant to Postgres's three-valued logic: NULL is
 * never `< now`, so a task with no deadline is already excluded (acceptance criterion
 * 8). It is written anyway because it makes this expression identical to the predicate
 * of the partial index `task_occurrence_user_deadline_idx` — the planner has to see the
 * same condition to prove the index covers the query.
 *
 * `now` is passed in rather than read as SQL `now()` so a caller (or a test) fixes the
 * instant it is comparing against, and every row in one request is judged against the
 * same moment.
 */
export function overdueCondition(now: Date): SQL {
  // `and()` returns `undefined` only when given no conditions at all; three literals
  // are passed here, so the assertion cannot fire.
  return and(
    isNotNull(taskOccurrence.deadlineAt),
    lt(taskOccurrence.deadlineAt, now),
    ne(taskOccurrence.status, "done"),
  )!;
}

/**
 * Make a user's `%` and `_` literal.
 *
 * Without it, searching for "50%" matches every task and "a_b" matches "axb".
 * The backslash is Postgres's default `ilike` escape character.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * The SQL half of the search-and-filter definition.
 *
 * **Its TypeScript twin is `matchesFilters` in `src/lib/tasks/filters.ts`.**
 * Materialised rows are filtered here; the occurrences a repeat rule is only
 * projecting are filtered there, because they do not exist as rows to filter.
 * The two have to agree, or a search returns a recurring task on the one day
 * somebody happened to touch it and on no other — a failure that produces no
 * error at all, just a list missing the thing the user was looking for.
 *
 * The same arrangement `overdueCondition` and `isOverdue` already have, and
 * `AGENTS.md` already requires those two to be changed together. So do these.
 *
 * Returns `undefined` when nothing is being filtered, so the caller composes the
 * exact query phase 3 shipped rather than one wrapped in a tautology.
 */
export function filterCondition(
  filters: TaskFilters | undefined,
): SQL | undefined {
  if (!hasAnyFilter(filters) || !filters) return undefined;

  const conditions: SQL[] = [];

  const search = filters.search?.trim();
  if (search) {
    // `ilike` rather than full-text: this is one person's task list, and
    // full-text does not match mid-word — which is exactly what someone typing
    // three letters expects. See the decision in `docs/gsd/phase-4-plan.md`.
    conditions.push(ilike(taskOccurrence.title, `%${escapeLike(search)}%`));
  }

  if (filters.statuses?.length) {
    conditions.push(inArray(taskOccurrence.status, [...filters.statuses]));
  }

  // Both bounds inclusive, compared as text — correct for a zero-padded `date`
  // column read in `mode: "string"`.
  if (filters.from) conditions.push(gte(taskOccurrence.occursOn, filters.from));
  if (filters.to) conditions.push(lte(taskOccurrence.occursOn, filters.to));

  if (filters.tagIds?.length) {
    /**
     * `exists` rather than a join, deliberately. Joining `occurrence_tags` would
     * return one row per matching tag, so a task carrying two of the selected
     * tags would appear twice — and the fix (`distinct`) would then have to be
     * remembered by every caller. `exists` asks the question the filter actually
     * poses: does this task carry *any* of them.
     */
    conditions.push(
      sql`exists (
        select 1 from ${occurrenceTags}
        where ${occurrenceTags.occurrenceId} = ${taskOccurrence.id}
          and ${occurrenceTags.tagId} in ${filters.tagIds}
      )`,
    );
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** `user_id = <caller>`, the clause every query in this module carries. */
function ownedBy(claims: UserClaims): SQL {
  return eq(taskOccurrence.userId, claims.sub);
}

/**
 * `id = <row> and user_id = <caller>`, for the two operations that name a single row.
 *
 * `update` and `remove` must filter on **both** columns. On `id` alone the statement is
 * only safe because RLS narrows it — and if a policy is ever dropped, altered, or the
 * query is ever run from a path that is not `withUser()`, "delete task 123" becomes
 * "delete anyone's task 123". The second `eq` is what makes the statement correct on
 * its own terms rather than correct by inheritance.
 */
function ownRow(claims: UserClaims, id: string): SQL {
  return and(eq(taskOccurrence.id, id), ownedBy(claims))!;
}

/** Fields a caller may set when creating a task. Note the absence of `userId`. */
export interface CreateOccurrenceInput {
  title: string;
  description?: string | null;
  /** A bare `YYYY-MM-DD` calendar day — a `date` column in `mode: "string"`, never a `Date`. */
  occursOn: string;
  deadlineAt?: Date | null;
  status?: TaskStatus;
  progressPct?: number;
  /** Minutes before `deadlineAt` to remind, or null for none. */
  reminderLeadMinutes?: number | null;
}

/**
 * Fields a caller may change. Every key is optional, and `undefined` means "leave
 * alone" while `null` means "clear it" — the distinction matters for `description`,
 * `deadlineAt` and `reminderLeadMinutes`, where removing one is a real edit and not
 * a no-op.
 */
export interface UpdateOccurrencePatch {
  title?: string;
  description?: string | null;
  occursOn?: string;
  deadlineAt?: Date | null;
  status?: TaskStatus;
  progressPct?: number;
  reminderLeadMinutes?: number | null;
}

/**
 * The caller's tasks for one calendar day.
 *
 * Ordered by deadline, then by creation. Postgres sorts NULLs last on an ASC order by
 * default, which is exactly the wanted reading: the things with a time on them come
 * first, in the order they come due, and the undated remainder follows. `createdAt`
 * breaks ties so a list does not reshuffle between two renders of the same data.
 */
export async function listForDay(
  claims: UserClaims,
  occursOn: string,
  filters?: TaskFilters,
): Promise<TaskOccurrence[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(taskOccurrence)
      .where(
        and(
          ownedBy(claims),
          eq(taskOccurrence.occursOn, occursOn),
          filterCondition(filters),
        ),
      )
      .orderBy(asc(taskOccurrence.deadlineAt), asc(taskOccurrence.createdAt)),
  );
}

/**
 * The derived overdue bucket: past its deadline and not finished.
 *
 * Deliberately not filtered by day. A task that was due last Tuesday is overdue today,
 * and the point of the bucket is that it surfaces regardless of which calendar square
 * it was planned for. Most-overdue first — `deadlineAt` cannot be NULL among these, so
 * the ordering has no NULL case to reason about.
 */
export async function listOverdue(
  claims: UserClaims,
  now: Date,
  filters?: TaskFilters,
): Promise<TaskOccurrence[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(taskOccurrence)
      .where(
        and(ownedBy(claims), overdueCondition(now), filterCondition(filters)),
      )
      .orderBy(asc(taskOccurrence.deadlineAt)),
  );
}

/**
 * Every task the caller owns, newest day first.
 *
 * Unpaginated on purpose for now: this backs a personal task list, where the row count
 * is bounded by one human's own history. When phase 3's recurrence starts generating
 * occurrences that stops being true, and this is the function that grows a cursor —
 * which is easier to see coming with the query in one place than spread across routers.
 */
export async function listAll(
  claims: UserClaims,
  filters?: TaskFilters,
): Promise<TaskOccurrence[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(taskOccurrence)
      .where(and(ownedBy(claims), filterCondition(filters)))
      .orderBy(desc(taskOccurrence.occursOn), desc(taskOccurrence.createdAt)),
  );
}

/**
 * Create one task owned by the caller, and return the row the database actually wrote.
 *
 * `status` and `progress_pct` are only sent when the caller supplied them, so the
 * column defaults in 0004 stay the single definition of "a new task starts at todo, 0%".
 * Restating those defaults here would create a second place that has to be changed.
 *
 * The returned row is read back with `.returning()` rather than reconstructed from the
 * input: `id`, `created_at` and `completed_at` are all decided by the database, and
 * `completed_at` in particular is set by a trigger the moment a task is created already
 * done.
 */
export async function create(
  claims: UserClaims,
  input: CreateOccurrenceInput,
): Promise<TaskOccurrence> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .insert(taskOccurrence)
      .values({
        userId: claims.sub,
        title: input.title,
        description: input.description ?? null,
        occursOn: input.occursOn,
        deadlineAt: input.deadlineAt ?? null,
        reminderLeadMinutes: input.reminderLeadMinutes ?? null,
        ...(input.status !== undefined && { status: input.status }),
        ...(input.progressPct !== undefined && {
          progressPct: input.progressPct,
        }),
      })
      .returning();

    // An INSERT that the `task_occurrence_insert_own` policy refuses raises rather than
    // returning nothing, so reaching here without a row is not a case to handle.
    return rows[0];
  });
}

/**
 * Apply a patch to one of the caller's tasks. Returns the updated row, or `null` when
 * no row matched — which covers "no such task" and "not yours" identically, because
 * from the caller's side those are the same fact and should not be distinguishable.
 *
 * The empty-patch branch is not defensive noise: Drizzle throws on `.set({})`, and a
 * patch where every field is `undefined` is a legitimate thing for a partial-update
 * boundary to produce. Reading the row back is the honest answer — nothing changed, so
 * nothing was written, and `updated_at` correctly does not move.
 */
export async function update(
  claims: UserClaims,
  id: string,
  patch: UpdateOccurrencePatch,
): Promise<TaskOccurrence | null> {
  return withUser(claims, async (tx) => {
    const values = {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.occursOn !== undefined && { occursOn: patch.occursOn }),
      ...(patch.deadlineAt !== undefined && { deadlineAt: patch.deadlineAt }),
      ...(patch.status !== undefined && { status: patch.status }),
      ...(patch.progressPct !== undefined && { progressPct: patch.progressPct }),
      ...(patch.reminderLeadMinutes !== undefined && {
        reminderLeadMinutes: patch.reminderLeadMinutes,
      }),
    };

    if (Object.keys(values).length === 0) {
      const current = await tx
        .select()
        .from(taskOccurrence)
        .where(ownRow(claims, id));
      return current[0] ?? null;
    }

    // No `completedAt` and no `updatedAt` in `values` — see the module header.
    const rows = await tx
      .update(taskOccurrence)
      .set(values)
      .where(ownRow(claims, id))
      .returning();

    return rows[0] ?? null;
  });
}

/**
 * Every materialised occurrence belonging to any of `seriesIds`.
 *
 * The other half of a recurring read: the rule says which dates exist, this says
 * which of them somebody has already touched. `src/lib/tasks/feed.ts` merges the
 * two, materialised winning.
 *
 * **Not windowed**, deliberately, and the asymmetry is the point. A virtual
 * occurrence is a projection and needs bounds; a row exists because a person
 * acted on that date, and it should not vanish from a list because it aged out
 * of a range. It is also what keeps a row on a date the *current* rule no longer
 * names visible at all — which is acceptance criterion 15.
 *
 * An empty `seriesIds` short-circuits rather than issuing `in ()`: Drizzle
 * renders that as a false constant, which is correct but still a round trip.
 */
export async function listForSeries(
  claims: UserClaims,
  seriesIds: readonly string[],
): Promise<TaskOccurrence[]> {
  if (seriesIds.length === 0) return [];

  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(taskOccurrence)
      .where(
        and(
          ownedBy(claims),
          inArray(taskOccurrence.seriesId, [...seriesIds]),
        ),
      )
      .orderBy(asc(taskOccurrence.occursOn)),
  );
}

/** The values `materialize` writes when an occurrence is first touched. */
export interface MaterializeOccurrenceInput {
  seriesId: string;
  /** The date the rule names. Part of the conflict target. */
  occursOn: string;
  /** Copied from the series at touch time, then owned by the row. */
  title: string;
  description?: string | null;
  /** Already resolved from (occurs_on + deadline_time) in the owner's zone. */
  deadlineAt?: Date | null;
  status?: TaskStatus;
  progressPct?: number;
  /** Seeded from the series' template lead unless the caller sent one. */
  reminderLeadMinutes?: number | null;
}

/**
 * Write the row for one occurrence of a series — the whole of "materialise on
 * touch".
 *
 * ## Why this is an upsert and not a select-then-insert
 *
 * `task_occurrence_series_day_uniq` (0005) is a *partial* unique index on
 * `(series_id, occurs_on) where series_id is not null`, and this is what it
 * exists for: `on conflict … do update` makes first-touch a single statement
 * that cannot lose a race to itself. A read-then-write would have a window
 * between the two in which a second request could insert, and the loser would
 * surface as a 23505 the user would read as "saving failed".
 *
 * `targetWhere` is required, not decoration — Postgres has to be given the
 * index's own predicate before it will infer a partial index as the conflict
 * target.
 *
 * ## What the conflict branch does and does not write
 *
 * Only the fields the caller actually supplied. A row that already exists is a
 * row somebody has worked on, so its `status` and `progress_pct` are the most
 * valuable things on it — an upsert that reset them to the series template on
 * every touch would destroy exactly what acceptance criteria 14 and 15 protect.
 * The title and notes are refreshed from the template, which is the same rule
 * `update` follows for a one-off: what the caller sent wins, what they omitted
 * is left alone.
 *
 * `completed_at` and `updated_at` are absent for the reason in the module
 * header: both are trigger-maintained.
 */
export async function materialize(
  claims: UserClaims,
  input: MaterializeOccurrenceInput,
): Promise<TaskOccurrence> {
  return withUser(claims, async (tx) => {
    const touched = {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.progressPct !== undefined && {
        progressPct: input.progressPct,
      }),
    };

    const rows = await tx
      .insert(taskOccurrence)
      .values({
        userId: claims.sub,
        seriesId: input.seriesId,
        title: input.title,
        description: input.description ?? null,
        occursOn: input.occursOn,
        deadlineAt: input.deadlineAt ?? null,
        reminderLeadMinutes: input.reminderLeadMinutes ?? null,
        ...touched,
      })
      .onConflictDoUpdate({
        target: [taskOccurrence.seriesId, taskOccurrence.occursOn],
        targetWhere: sql`${taskOccurrence.seriesId} is not null`,
        set: {
          title: input.title,
          description: input.description ?? null,
          deadlineAt: input.deadlineAt ?? null,
          // Refreshed from what the caller sent, exactly like the deadline above
          // and for the same reason: the caller resolved it from the template
          // when they had nothing of their own to send. `status` and
          // `progress_pct` stay in `touched` because they are the work.
          reminderLeadMinutes: input.reminderLeadMinutes ?? null,
          ...touched,
        },
      })
      .returning();

    return rows[0];
  });
}

/**
 * Delete one of the caller's tasks. `true` when a row went, `false` when none matched.
 *
 * `.returning()` is what makes the boolean meaningful: a DELETE that matches nothing is
 * a perfectly successful statement, so without reading back what left, this could only
 * report "the statement ran".
 *
 * Named `remove` because `delete` is a reserved word.
 */
export async function remove(
  claims: UserClaims,
  id: string,
): Promise<boolean> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .delete(taskOccurrence)
      .where(ownRow(claims, id))
      .returning({ id: taskOccurrence.id });

    return rows.length > 0;
  });
}
