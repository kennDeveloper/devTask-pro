/**
 * How the client names an occurrence that is not a row yet.
 *
 * ============================================================================
 * THE PROBLEM THIS SOLVES
 * ============================================================================
 *
 * Occurrences of a series are materialised **on touch, never on read**. So a
 * list contains two kinds of thing that look identical on screen: rows, which
 * have a `task_occurrence.id`, and projections of a rule, which have nothing to
 * be identified by. The moment somebody moves a slider, the second kind has to
 * become the first.
 *
 * The obvious shapes both cost more than they look:
 *
 *   - **A nullable `id`** ripples into every `key=`, every `data-task-id`, and
 *     every control id (`row-${id}-status`) in `task-row.tsx` and
 *     `task-card.tsx` — none of which have any business knowing that some
 *     occurrences are not rows yet.
 *   - **A separate "materialise then patch" mutation** means the row and card
 *     control handlers grow a branch, `use-task-actions.ts` grows a fourth
 *     mutation, and the in-flight state that disables a row is split in two.
 *
 * So a virtual occurrence gets a **synthetic, deterministic id** instead:
 * `series:<uuid>:<YYYY-MM-DD>`. It is a stable React key, it is obviously not a
 * row id, and it travels through `task.update` exactly like a real one — the
 * router branches on it, and nothing above the router changes.
 *
 * Parsing lives here and nowhere else. A component that split an id on `":"`
 * would be a second place that has to keep agreeing with this one.
 */

import { z } from "zod";

import { isCalendarDate } from "./validators";

/**
 * The marker. A colon-delimited scheme rather than something denser because it
 * shows up in `data-task-id` and in a failing test's output, and "this is
 * occurrence 2026-08-06 of series abc" should be readable there.
 */
export const VIRTUAL_OCCURRENCE_PREFIX = "series:";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A materialised row, named by its primary key. */
export interface RowOccurrenceRef {
  kind: "row";
  id: string;
}

/** An occurrence the rule names but nobody has touched yet. */
export interface VirtualOccurrenceRef {
  kind: "virtual";
  seriesId: string;
  /** `YYYY-MM-DD`. */
  occursOn: string;
}

export type OccurrenceRef = RowOccurrenceRef | VirtualOccurrenceRef;

/** `series:<uuid>:<YYYY-MM-DD>` — the id a virtual occurrence travels under. */
export function virtualOccurrenceId(
  seriesId: string,
  occursOn: string,
): string {
  return `${VIRTUAL_OCCURRENCE_PREFIX}${seriesId}:${occursOn}`;
}

/** True for an id this module minted. Cheap enough to call per row. */
export function isVirtualOccurrenceId(value: string): boolean {
  return value.startsWith(VIRTUAL_OCCURRENCE_PREFIX);
}

/**
 * An id as the thing it names, or `null` when it names nothing valid.
 *
 * Strict on both branches: a row ref must be a real uuid and a virtual ref must
 * carry a real uuid *and* a date that exists. The alternative — accepting
 * `series:whatever:2026-02-31` and letting Postgres reject the cast — turns a
 * 400 naming the field into a 500 carrying a driver message.
 */
export function parseOccurrenceRef(value: string): OccurrenceRef | null {
  if (typeof value !== "string" || value.length === 0) return null;

  if (!isVirtualOccurrenceId(value)) {
    return UUID_PATTERN.test(value) ? { kind: "row", id: value } : null;
  }

  const body = value.slice(VIRTUAL_OCCURRENCE_PREFIX.length);
  // `lastIndexOf` rather than `split`: a uuid contains no colon today, but
  // splitting on every colon would silently mangle the id if that ever changed,
  // whereas the date at the end is a fixed shape.
  const at = body.lastIndexOf(":");
  if (at <= 0) return null;

  const seriesId = body.slice(0, at);
  const occursOn = body.slice(at + 1);

  if (!UUID_PATTERN.test(seriesId)) return null;
  if (!isCalendarDate(occursOn)) return null;

  return { kind: "virtual", seriesId, occursOn };
}

/** The message a bad reference produces at the tRPC boundary. */
export const OCCURRENCE_REF_MESSAGE = "That task reference is not valid.";

/**
 * The Zod schema for "an occurrence, however it is identified".
 *
 * Used by `task.update`, which accepts both kinds because touching a virtual
 * occurrence is what materialises it. **Not** used by `task.remove`: deleting a
 * virtual occurrence would be "skip this one occurrence", which is out of v1, so
 * that procedure keeps a plain uuid and a virtual ref fails at the boundary with
 * a message rather than being quietly ignored.
 */
export const occurrenceRefField = z
  .string({ error: OCCURRENCE_REF_MESSAGE })
  .refine((value) => parseOccurrenceRef(value) !== null, {
    error: OCCURRENCE_REF_MESSAGE,
  });
