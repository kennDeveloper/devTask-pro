import { and, eq, inArray, sql, type SQL } from "drizzle-orm";

import { withUser, type ScopedTx, type UserClaims } from "@/lib/db/rls";
import {
  occurrenceTags,
  seriesTags,
  tags,
  type Tag,
  type TagColor,
} from "@/lib/db/schema";

/**
 * The `tags` repository, and the two join tables that attach them.
 *
 * ============================================================================
 * EVERY FUNCTION HERE OPENS ITS OWN `withUser()`. `dbAdmin` DOES NOT APPEAR.
 * ============================================================================
 *
 * Same contract as `./occurrences.ts` and `./series.ts`. A tag is a label a
 * person chose and applied to their private work, which makes the set of them a
 * fair description of what somebody does all day — so it is task data, and the
 * same boundary applies. `tags.test.ts` carries the source-level guard that
 * asserts `dbAdmin` is not imported.
 *
 * ## Why the writes take a whole set rather than add/remove deltas
 *
 * `setForOccurrence` and `setForSeries` replace the links in one transaction.
 * The picker holds the complete selection anyway, and a delta API would need the
 * client to know which links already exist — a second source of truth for
 * something the server can simply be told. Replacing also makes the operation
 * idempotent, which matters because materialisation calls it on every touch.
 *
 * ## Why `user_id` is written explicitly on a join row
 *
 * The composite foreign keys in 0006 reference `(id, user_id)` on both parents,
 * so a link row states the owner and the database checks that the tag *and* the
 * task agree with it. Passing `claims.sub` here is what feeds that check — and
 * why "attach my tag to someone else's task" fails on the FK rather than relying
 * on a policy to notice.
 */

/** `user_id = <caller>`, the clause every query in this module carries. */
function ownedBy(claims: UserClaims): SQL {
  return eq(tags.userId, claims.sub);
}

/** Every tag the caller owns, alphabetically — the order the manager renders. */
export async function list(claims: UserClaims): Promise<Tag[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(tags)
      .where(ownedBy(claims))
      // `lower()` so "Work" and "admin" sort the way a person reads them rather
      // than with every capital letter first.
      .orderBy(sql`lower(${tags.name})`),
  );
}

export interface CreateTagInput {
  name: string;
  color?: TagColor;
}

/**
 * Create one tag owned by the caller.
 *
 * A name colliding case-insensitively with an existing one raises on
 * `tags_user_name_uniq`. Deliberately not caught here: the router turns it into a
 * `CONFLICT` with a sentence, and swallowing it in the repo would leave the
 * caller unable to tell "created" from "already existed".
 */
export async function create(
  claims: UserClaims,
  input: CreateTagInput,
): Promise<Tag> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .insert(tags)
      .values({
        userId: claims.sub,
        name: input.name,
        ...(input.color !== undefined && { color: input.color }),
      })
      .returning();

    return rows[0];
  });
}

export interface UpdateTagPatch {
  name?: string;
  color?: TagColor;
}

/**
 * Rename or recolour one of the caller's tags. `null` when none matched.
 *
 * **Writes nothing to `task_occurrence` or `task_series`.** A tag is referenced
 * by id, so renaming it is reflected everywhere it appears without touching a
 * single task — which is acceptance criterion 4, and a property of the schema
 * rather than of this function.
 */
export async function update(
  claims: UserClaims,
  id: string,
  patch: UpdateTagPatch,
): Promise<Tag | null> {
  return withUser(claims, async (tx) => {
    const values = {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.color !== undefined && { color: patch.color }),
    };

    if (Object.keys(values).length === 0) {
      const current = await tx
        .select()
        .from(tags)
        .where(and(eq(tags.id, id), ownedBy(claims)));
      return current[0] ?? null;
    }

    const rows = await tx
      .update(tags)
      .set(values)
      .where(and(eq(tags.id, id), ownedBy(claims)))
      .returning();

    return rows[0] ?? null;
  });
}

/**
 * Delete one of the caller's tags. `true` when a row went.
 *
 * A hard delete. The `on delete cascade` on both join tables removes the links
 * and stops there, so no task is touched — acceptance criterion 3, again as a
 * property of the schema. A soft delete would buy nothing (a label carries no
 * history worth keeping) and cost a `deleted_at is null` on every join for the
 * rest of the project's life.
 */
export async function remove(
  claims: UserClaims,
  id: string,
): Promise<boolean> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .delete(tags)
      .where(and(eq(tags.id, id), ownedBy(claims)))
      .returning({ id: tags.id });

    return rows.length > 0;
  });
}

/** One occurrence or series and the tag it carries — a flat join row. */
export interface TagLink {
  ownerId: string;
  tag: Tag;
}

/**
 * The tags on a set of occurrences, as one query.
 *
 * Returned flat and grouped by the caller (`src/lib/tasks/feed.ts` builds the
 * `Map`), because a list read wants **one** query for the whole page rather than
 * one per row. Empty input short-circuits rather than issuing `in ()`.
 */
export async function tagsForOccurrences(
  claims: UserClaims,
  occurrenceIds: readonly string[],
): Promise<TagLink[]> {
  if (occurrenceIds.length === 0) return [];

  return withUser(claims, async (tx) =>
    tx
      .select({ ownerId: occurrenceTags.occurrenceId, tag: tags })
      .from(occurrenceTags)
      .innerJoin(tags, eq(tags.id, occurrenceTags.tagId))
      .where(
        and(
          eq(occurrenceTags.userId, claims.sub),
          inArray(occurrenceTags.occurrenceId, [...occurrenceIds]),
        ),
      )
      .orderBy(sql`lower(${tags.name})`),
  );
}

/** The template tags on a set of series. Same shape, same one-query rule. */
export async function tagsForSeries(
  claims: UserClaims,
  seriesIds: readonly string[],
): Promise<TagLink[]> {
  if (seriesIds.length === 0) return [];

  return withUser(claims, async (tx) =>
    tx
      .select({ ownerId: seriesTags.seriesId, tag: tags })
      .from(seriesTags)
      .innerJoin(tags, eq(tags.id, seriesTags.tagId))
      .where(
        and(
          eq(seriesTags.userId, claims.sub),
          inArray(seriesTags.seriesId, [...seriesIds]),
        ),
      )
      .orderBy(sql`lower(${tags.name})`),
  );
}

/**
 * Both sides of a list read's tags, in **one** scoped transaction.
 *
 * ## Why this exists rather than two calls
 *
 * `withUser()` is not free. Each call borrows a connection, opens a transaction,
 * runs `set_config('request.jwt.claims', …)` and `set local role authenticated`,
 * and commits — that is the mechanism the whole access model rests on, and the
 * cost is paid per call rather than per statement.
 *
 * Phase 4 added tags to a feed that already made two such calls (the rows and the
 * series), which would have made four. Two of them ask questions answered against
 * the same identity at the same instant, so they belong in the same transaction:
 * one demotion, two selects. That removes a doubling which would otherwise have
 * been permanent, and it is measurable under the concurrency the e2e suite
 * generates.
 *
 * This changes how many *transactions* a list costs, not how many queries — the
 * two selects are still the two `feed.ts` needs.
 */
export async function tagsForFeed(
  claims: UserClaims,
  occurrenceIds: readonly string[],
  seriesIds: readonly string[],
): Promise<{ occurrenceLinks: TagLink[]; seriesLinks: TagLink[] }> {
  if (occurrenceIds.length === 0 && seriesIds.length === 0) {
    return { occurrenceLinks: [], seriesLinks: [] };
  }

  return withUser(claims, async (tx) => {
    const occurrenceLinks =
      occurrenceIds.length === 0
        ? []
        : await tx
            .select({ ownerId: occurrenceTags.occurrenceId, tag: tags })
            .from(occurrenceTags)
            .innerJoin(tags, eq(tags.id, occurrenceTags.tagId))
            .where(
              and(
                eq(occurrenceTags.userId, claims.sub),
                inArray(occurrenceTags.occurrenceId, [...occurrenceIds]),
              ),
            )
            .orderBy(sql`lower(${tags.name})`);

    const seriesLinks =
      seriesIds.length === 0
        ? []
        : await tx
            .select({ ownerId: seriesTags.seriesId, tag: tags })
            .from(seriesTags)
            .innerJoin(tags, eq(tags.id, seriesTags.tagId))
            .where(
              and(
                eq(seriesTags.userId, claims.sub),
                inArray(seriesTags.seriesId, [...seriesIds]),
              ),
            )
            .orderBy(sql`lower(${tags.name})`);

    return { occurrenceLinks, seriesLinks };
  });
}

/**
 * Replace an occurrence's tags, inside an already-open transaction.
 *
 * Takes `tx` rather than opening its own `withUser` because materialisation has
 * to write the occurrence and its tags **together** — an occurrence that exists
 * for a moment carrying none of its series' tags would blink out of a filtered
 * list. `setForOccurrence` below is the wrapper for callers not already in one.
 *
 * Delete-then-insert rather than a diff: the set is small, the statement is
 * obvious, and it makes the operation idempotent — which matters because every
 * touch of a projected occurrence calls it.
 */
export async function setForOccurrenceIn(
  tx: ScopedTx,
  claims: UserClaims,
  occurrenceId: string,
  tagIds: readonly string[],
): Promise<void> {
  await tx
    .delete(occurrenceTags)
    .where(
      and(
        eq(occurrenceTags.occurrenceId, occurrenceId),
        eq(occurrenceTags.userId, claims.sub),
      ),
    );

  if (tagIds.length === 0) return;

  await tx.insert(occurrenceTags).values(
    tagIds.map((tagId) => ({
      userId: claims.sub,
      occurrenceId,
      tagId,
    })),
  );
}

/** Replace an occurrence's tags. See `setForOccurrenceIn` for the reasoning. */
export async function setForOccurrence(
  claims: UserClaims,
  occurrenceId: string,
  tagIds: readonly string[],
): Promise<void> {
  return withUser(claims, async (tx) =>
    setForOccurrenceIn(tx, claims, occurrenceId, tagIds),
  );
}

/**
 * Replace a series' template tags.
 *
 * Writes to `series_tags` and nowhere else. Occurrences that already exist keep
 * the tags they were materialised with — the same rule every other series field
 * follows, and acceptance criterion 6.
 */
export async function setForSeries(
  claims: UserClaims,
  seriesId: string,
  tagIds: readonly string[],
): Promise<void> {
  return withUser(claims, async (tx) => {
    await tx
      .delete(seriesTags)
      .where(
        and(
          eq(seriesTags.seriesId, seriesId),
          eq(seriesTags.userId, claims.sub),
        ),
      );

    if (tagIds.length === 0) return;

    await tx.insert(seriesTags).values(
      tagIds.map((tagId) => ({
        userId: claims.sub,
        seriesId,
        tagId,
      })),
    );
  });
}
