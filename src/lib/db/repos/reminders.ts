import { and, eq, gte, isNotNull, type SQL } from "drizzle-orm";

import { withUser, type UserClaims } from "@/lib/db/rls";
import { reminderLog, type ReminderLog } from "@/lib/db/schema";

/**
 * The `reminder_log` repository — the at-most-once ledger behind criteria 21
 * and 22.
 *
 * ============================================================================
 * EVERY FUNCTION HERE OPENS ITS OWN `withUser()`. `dbAdmin` DOES NOT APPEAR.
 * ============================================================================
 *
 * Same contract as `./occurrences.ts`, `./series.ts` and `./tags.ts`, and worth
 * stating plainly because this is the one repo a background job calls. A cron
 * run has no session, so the temptation is to reach for the owner connection and
 * scan every user's rows at once. It does not: `runReminders` resolves one
 * account at a time and hands its `sub` to these functions, so the policies in
 * 0007 are enforced on the job exactly as they are on a person. The source-level
 * guard in `reminders.test.ts` is what keeps that true.
 *
 * ## A reminder is identified by the occurrence, not by a row
 *
 * Most upcoming occurrences of a series are projections — the rule names the
 * date and nobody has touched it, so there is no `task_occurrence` row to point
 * at. The job must not create one either: criteria 15 and 17 hold precisely
 * because untouched occurrences are never rows (see `./series.ts` and the header
 * of `0007_reminders.sql`). So the ledger keys on:
 *
 *   a series occurrence  →  (series_id, occurs_on)   materialised or not
 *   a one-off task       →  (occurrence_id)
 *
 * The series key deliberately does not change when somebody later touches that
 * date, which is what stops a second reminder firing for an occurrence the job
 * has already sent for.
 *
 * ## Append-only
 *
 * There is no `update` and no `remove` here, and 0007 grants `authenticated`
 * neither privilege. "A reminder was already sent for this occurrence" is the
 * fact criterion 21 rests on, and an account that could delete its own log rows
 * could make the job send again.
 */

/**
 * Which occurrence a log row is about.
 *
 * A discriminated union rather than two nullable ids, so a caller cannot
 * construct the half-populated shape the `reminder_log_one_target` check would
 * reject at the far end of a round trip.
 */
export type ReminderKey =
  | { kind: "series"; seriesId: string; occursOn: string }
  | { kind: "occurrence"; occurrenceId: string; occursOn: string };

/** The two identities as one comparable string, for set membership. */
export function reminderKeyToken(key: ReminderKey): string {
  return key.kind === "series"
    ? `series:${key.seriesId}:${key.occursOn}`
    : `occurrence:${key.occurrenceId}`;
}

/** `user_id = <caller>`, the clause every query in this module carries. */
function ownedBy(claims: UserClaims): SQL {
  return eq(reminderLog.userId, claims.sub);
}

/**
 * The keys the caller has already been reminded about, on or after `since`.
 *
 * Bounded rather than unbounded because the ledger only grows: a run needs to
 * know about reminders for occurrences still inside its horizon, and comparing
 * against every row a long-lived account ever accumulated would make each run
 * slower than the last. `since` is compared against `occurs_on` rather than
 * `sent_at` — the question is "which upcoming occurrences are already handled",
 * and a reminder for a distant occurrence may have been sent long ago.
 *
 * This is a read-side optimisation and **not** the at-most-once mechanism. That
 * is `claim()`, which is atomic; this merely avoids attempting claims that would
 * certainly conflict.
 */
export async function listSentKeys(
  claims: UserClaims,
  since: string,
): Promise<ReminderKey[]> {
  const rows = await withUser(claims, async (tx) =>
    tx
      .select()
      .from(reminderLog)
      .where(and(ownedBy(claims), gte(reminderLog.occursOn, since))),
  );

  return rows.map(keyOf);
}

/** A stored row as its key. Exactly one of the two ids is set (0007's check). */
function keyOf(row: ReminderLog): ReminderKey {
  return row.seriesId
    ? { kind: "series", seriesId: row.seriesId, occursOn: row.occursOn }
    : {
        kind: "occurrence",
        occurrenceId: row.occurrenceId!,
        occursOn: row.occursOn,
      };
}

export interface ClaimReminderInput {
  key: ReminderKey;
  /** The instant the reminder counts back from, recorded for the ledger. */
  deadlineAt: Date;
}

/**
 * Claim the right to send one reminder. `true` when this call won it.
 *
 * ============================================================================
 * THIS IS ACCEPTANCE CRITERION 21, AND THE ORDER MATTERS.
 * ============================================================================
 *
 * The caller inserts *first* and sends only on `true`. `on conflict do nothing`
 * against the partial unique index for this key makes the claim atomic, so two
 * overlapping runs — a slow one still working while the next tick starts —
 * cannot both come away believing they should send. `.returning()` is what makes
 * the boolean mean anything: an INSERT that conflicts is a perfectly successful
 * statement, so without reading back what was written this could only report
 * "the statement ran".
 *
 * **The trade-off, recorded deliberately.** A send that throws after a
 * successful claim is a missed reminder, not a retried one. The criterion is
 * *at most once*; at-least-once would need a retry ledger, a backoff and a
 * poison-message story, which this feature has not earned. The failure is
 * counted in the run summary rather than swallowed.
 *
 * `onConflictDoNothing` is given no target on purpose. Both unique indexes are
 * partial, and only one of them can apply to any given row — the
 * `reminder_log_one_target` check guarantees that. Naming a target would mean
 * restating each index's predicate here and picking between them on the key's
 * shape, for no gain: a bare `do nothing` covers whichever one fires.
 */
export async function claim(
  claims: UserClaims,
  input: ClaimReminderInput,
): Promise<boolean> {
  const { key, deadlineAt } = input;

  return withUser(claims, async (tx) => {
    const rows = await tx
      .insert(reminderLog)
      .values({
        userId: claims.sub,
        seriesId: key.kind === "series" ? key.seriesId : null,
        occurrenceId: key.kind === "occurrence" ? key.occurrenceId : null,
        occursOn: key.occursOn,
        deadlineAt,
      })
      .onConflictDoNothing()
      .returning({ id: reminderLog.id });

    return rows.length > 0;
  });
}

/**
 * Every log row the caller owns for one series, oldest occurrence first.
 *
 * Not used by the job — it exists for the integration suite, which has to be
 * able to assert "exactly one row for this occurrence after two runs" without
 * reaching for `dbAdmin` and proving something about a different connection than
 * the one the job actually uses.
 */
export async function listForSeries(
  claims: UserClaims,
  seriesId: string,
): Promise<ReminderLog[]> {
  return withUser(claims, async (tx) =>
    tx
      .select()
      .from(reminderLog)
      .where(
        and(
          ownedBy(claims),
          isNotNull(reminderLog.seriesId),
          eq(reminderLog.seriesId, seriesId),
        ),
      )
      .orderBy(reminderLog.occursOn),
  );
}
