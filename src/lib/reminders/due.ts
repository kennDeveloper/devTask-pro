/**
 * Which reminders are due, defined once and without touching anything.
 *
 * Every function here is pure and takes `now` as a parameter, for the reason
 * `isOverdue` gives: a predicate that reads the ambient clock cannot be tested
 * at a boundary. The job passes one instant for a whole run, so every account in
 * that run is judged against the same moment.
 *
 * ## The send window is half-open: `[deadline − lead, deadline)`
 *
 * A reminder becomes due when the lead time is reached and stops being due when
 * the deadline passes. **A reminder that missed its moment is skipped, not
 * delivered late.** "Due in 30 minutes" three days after the fact is worse than
 * silence, and the task is already surfacing in the Overdue bucket, which is
 * this application's existing answer to lateness.
 *
 * That right-hand bound is the only real judgement call in this file, and it is
 * why `skippedLate` is reported by the run rather than quietly dropped — a
 * reminder nobody received should be visible somewhere.
 *
 * ## Why this reads `ListedOccurrence`
 *
 * Because the job reads the same feed the user's own screens read, so a
 * projection of a repeat rule and a stored row arrive here in one shape and get
 * one code path. That is what lets a reminder fire for an occurrence nobody has
 * touched **without writing a row for it** — the guarantee criteria 15 and 17
 * depend on. A `status` of `done` is impossible on a projection by construction,
 * so criterion 22 is satisfied for that half by definition rather than by check;
 * the check below is what covers a materialised row.
 */

import { reminderKeyToken, type ReminderKey } from "@/lib/db/repos/reminders";
import { isDone } from "@/lib/tasks/status";

import type { ListedOccurrence } from "@/lib/tasks/feed";

/** One reminder the job should attempt, with everything the send needs. */
export interface ReminderCandidate {
  key: ReminderKey;
  /** The instant the reminder became due — `deadlineAt − lead`. */
  fireAt: Date;
  /** The instant the task is due. Recorded on the ledger and shown in the mail. */
  deadlineAt: Date;
  occurrence: ListedOccurrence;
}

/** What `dueReminders` decided about a feed, so a run can report on it. */
export interface ReminderSelection {
  due: ReminderCandidate[];
  /**
   * Reminders whose moment passed unseen — the job was down, or the cadence is
   * slower than the lead. Counted rather than sent; see the header.
   */
  skippedLate: number;
}

/**
 * Which occurrence this is, for the ledger.
 *
 * An occurrence of a series is keyed by `(series_id, occurs_on)` **whether or
 * not it has been materialised**, which is what stops a second reminder firing
 * once somebody touches a date the job already sent for. A one-off is keyed by
 * its row id, which it always has.
 *
 * `null` for a projection of a series with no id, which cannot occur through the
 * feed but is not worth crashing a whole run over if it ever did.
 */
export function reminderKeyFor(
  occurrence: ListedOccurrence,
): ReminderKey | null {
  if (occurrence.seriesId) {
    return {
      kind: "series",
      seriesId: occurrence.seriesId,
      occursOn: occurrence.occursOn,
    };
  }

  // A virtual occurrence with no series has no stable identity at all — its
  // `id` is synthetic. There is no such thing through the feed (a projection
  // always comes from a series), and sending on one would mean a reminder the
  // ledger could not record.
  if (occurrence.virtual) return null;

  return {
    kind: "occurrence",
    occurrenceId: occurrence.id,
    occursOn: occurrence.occursOn,
  };
}

/**
 * The instant a reminder for `occurrence` becomes due, or `null` when it has
 * none.
 *
 * Null in three cases, all of which mean "no reminder" rather than "an error":
 * no lead was set, there is no deadline to count back from (criterion 8's tasks
 * are never late and so never remind), or the lead is not a usable number.
 */
export function fireAt(occurrence: ListedOccurrence): Date | null {
  const { reminderLeadMinutes, deadlineAt } = occurrence;

  if (reminderLeadMinutes == null) return null;
  if (deadlineAt == null) return null;
  if (!Number.isFinite(reminderLeadMinutes)) return null;

  return new Date(deadlineAt.getTime() - reminderLeadMinutes * 60_000);
}

/**
 * The reminders in `feed` that should be sent as of `now`, excluding any whose
 * key is in `alreadySent`.
 *
 * `alreadySent` is a read-side filter and **not** the at-most-once mechanism —
 * that is `reminders.claim()`, which is atomic. Passing the known keys here
 * simply avoids attempting claims that would certainly conflict.
 */
export function dueReminders(
  feed: readonly ListedOccurrence[],
  now: Date,
  alreadySent: ReadonlySet<string> = new Set(),
): ReminderSelection {
  const due: ReminderCandidate[] = [];
  let skippedLate = 0;

  for (const occurrence of feed) {
    // Criterion 22. Impossible on a projection, real on a materialised row.
    if (isDone(occurrence.status)) continue;

    const at = fireAt(occurrence);
    if (!at) continue;

    // Non-null wherever `fireAt` returned a date — it is derived from this.
    const deadlineAt = occurrence.deadlineAt!;

    // Not yet. The next run, or the one after, will pick it up.
    if (now.getTime() < at.getTime()) continue;

    const key = reminderKeyFor(occurrence);
    if (!key) continue;

    // Already handled. Checked before the lateness count so a reminder that was
    // sent on time is not also reported as one that was missed.
    if (alreadySent.has(reminderKeyToken(key))) continue;

    // The moment passed unseen. See the header for why this is not sent.
    if (now.getTime() >= deadlineAt.getTime()) {
      skippedLate += 1;
      continue;
    }

    due.push({ key, fireAt: at, deadlineAt, occurrence });
  }

  return { due, skippedLate };
}
