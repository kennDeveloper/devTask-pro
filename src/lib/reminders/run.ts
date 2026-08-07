import * as profilesRepo from "@/lib/db/repos/profiles";
import * as remindersRepo from "@/lib/db/repos/reminders";
import { reminderKeyToken } from "@/lib/db/repos/reminders";
import { sendEmail } from "@/lib/email/send";
import { reminderEmail } from "@/lib/email/templates";
import * as feed from "@/lib/tasks/feed";
import { addDaysToIsoDate } from "@/lib/time/day-boundary";
import { todayInZone } from "@/lib/time/user-tz";

import { dueReminders, type ReminderCandidate } from "./due";

import type { ReminderRecipient } from "@/lib/db/repos/profiles";

/**
 * The reminder run — the only thing in this application that acts without a
 * person having asked.
 *
 * ============================================================================
 * IT RUNS INSIDE ROW LEVEL SECURITY, AND THAT IS THE POINT.
 * ============================================================================
 *
 * A cron run has no session, so the obvious shape is one privileged query
 * joining every user's tasks at once. This does not do that. It escalates
 * exactly once — `listActiveRecipientsAsAdmin()`, inside the fenced section of
 * the profiles repo, which may name `profiles` and `auth.users` and nothing else
 * — and then opens `withUser({ sub })` per account and reads that person's tasks
 * through the ordinary feed, where the policies apply exactly as they do to
 * somebody at a browser.
 *
 * Three things follow, and each is worth the extra transactions:
 *
 *   1. The reminder sees precisely what the user sees. Not an approximation of
 *      the feed rebuilt in a job that will drift from it.
 *   2. `mergeOccurrences` dedupes a materialised date against its projection
 *      for free, so the run cannot produce two candidates for one reminder.
 *   3. Phase 6 adds **no** entry to `isolation.test.ts`'s sanctioned `dbAdmin`
 *      importer set. That test passing unchanged is the proof.
 *
 * ## It writes nothing to `task_occurrence`
 *
 * Not as an optimisation — as the guarantee criteria 15 and 17 rest on.
 * Untouched occurrences are not rows, and a job that materialised them would
 * leave rows on dates a later rule edit no longer names and rows that outlive a
 * soft-deleted series. The only table this run writes is `reminder_log`. See the
 * header of `supabase/migrations/0007_reminders.sql`.
 *
 * ## The cost, stated rather than hidden
 *
 * `listAllFeed` loads tags and every stored row the account owns, and the run
 * needs neither. That is real waste and it is the right trade at this scale: a
 * narrower query would be a second definition of "what tasks does this person
 * have", and the two would eventually disagree about something like a
 * soft-deleted series. If account volume ever makes this unreasonable, the fix
 * is a reminder-candidate query in `feed.ts` beside the others — **not** a
 * `dbAdmin` scan.
 */

/** What one run did. Aggregate only — see the note in the route handler. */
export interface ReminderRunSummary {
  recipients: number;
  /** Reminders that were due and not already in the ledger. */
  candidates: number;
  /** Claims this run won. A claim it lost means another run had it. */
  claimed: number;
  sent: number;
  /** Claimed, then the send threw. A missed reminder, not a retried one. */
  failed: number;
  /** Due, but the deadline had already passed. Deliberately not sent. */
  skippedLate: number;
}

const EMPTY: ReminderRunSummary = {
  recipients: 0,
  candidates: 0,
  claimed: 0,
  sent: 0,
  failed: 0,
  skippedLate: 0,
};

/**
 * How far back to read the ledger.
 *
 * Two days rather than "from today", because an occurrence sitting on
 * yesterday's calendar square can still have a deadline in the future — a task
 * on the 7th due at 02:00 on the 8th, in a zone far enough east. Reading too
 * narrowly is not a correctness problem, only a wasted claim attempt that
 * `on conflict do nothing` refuses; reading a little wide costs nothing.
 */
const LEDGER_LOOKBACK_DAYS = 2;

/**
 * Send every reminder due as of `now`, for every active account.
 *
 * `now` is a parameter, not `new Date()` — one instant for the whole run, so two
 * accounts processed a second apart are judged against the same moment, and so
 * the integration suite can drive it at a fixed time.
 */
export async function runReminders(now: Date): Promise<ReminderRunSummary> {
  const recipients = await profilesRepo.listActiveRecipientsAsAdmin();

  const summary: ReminderRunSummary = { ...EMPTY, recipients: recipients.length };

  for (const recipient of recipients) {
    // One account's failure — an unreadable timezone, a dropped connection —
    // must not stop everybody else's mail.
    try {
      const forOne = await remindOne(recipient, now);
      summary.candidates += forOne.candidates;
      summary.claimed += forOne.claimed;
      summary.sent += forOne.sent;
      summary.failed += forOne.failed;
      summary.skippedLate += forOne.skippedLate;
    } catch (error) {
      summary.failed += 1;
      console.error(`[reminders] account ${recipient.id} failed`, error);
    }
  }

  return summary;
}

/** One account's reminders. Everything here runs inside that account's RLS. */
async function remindOne(
  recipient: ReminderRecipient,
  now: Date,
): Promise<Omit<ReminderRunSummary, "recipients">> {
  const claims = { sub: recipient.id, email: recipient.email };
  const today = todayInZone(recipient.timezone, now);

  const [entries, sentKeys] = await Promise.all([
    // The ordinary read path, inside `withUser()`. Rows and projections merged,
    // rows winning — so a materialised date never also arrives as a projection.
    feed.listAllFeed(claims, today, recipient.timezone),
    remindersRepo.listSentKeys(
      claims,
      addDaysToIsoDate(today, -LEDGER_LOOKBACK_DAYS),
    ),
  ]);

  const alreadySent = new Set(sentKeys.map(reminderKeyToken));
  const { due, skippedLate } = dueReminders(entries, now, alreadySent);

  let claimed = 0;
  let sent = 0;
  let failed = 0;

  for (const candidate of due) {
    // CLAIM FIRST. Only the run that writes the ledger row may send, which is
    // what stops two overlapping runs both mailing the same reminder. A send
    // that throws afterwards is a missed reminder rather than a retried one —
    // the at-most-once trade-off recorded on `reminders.claim()`.
    const won = await remindersRepo.claim(claims, {
      key: candidate.key,
      deadlineAt: candidate.deadlineAt,
    });
    if (!won) continue;

    claimed += 1;

    try {
      await sendEmail({
        to: recipient.email,
        ...messageFor(candidate, recipient.timezone),
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[reminders] send failed for ${reminderKeyToken(candidate.key)}`,
        error,
      );
    }
  }

  return { candidates: due.length, claimed, sent, failed, skippedLate };
}

/**
 * The message for one candidate.
 *
 * The link goes to `/tasks` rather than a deep link to the occurrence, and that
 * is a limitation rather than a preference: a projected occurrence has no route
 * of its own, and `/tasks` does not read search params — its filters are client
 * state — so `?from=&to=` would be a link that silently filters nothing. Making
 * the filters URL-driven is a real feature and belongs in its own change.
 * `/today` was the alternative and is wrong for any lead longer than a day.
 */
function messageFor(candidate: ReminderCandidate, timeZone: string) {
  return reminderEmail({
    title: candidate.occurrence.title,
    deadlineAt: candidate.deadlineAt,
    timeZone,
    url: taskUrl(),
    leadMinutes: candidate.occurrence.reminderLeadMinutes!,
  });
}

/**
 * An absolute URL into the app.
 *
 * `NEXT_PUBLIC_SITE_URL` is the convention already used by
 * `src/lib/supabase/admin.ts` and `src/lib/auth/redirect.ts`. Falling back to
 * the local origin keeps a dev run from throwing on a variable nobody has set
 * yet; in production the variable is set because the auth redirects need it too.
 */
function taskUrl(): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    "http://127.0.0.1:3000";

  return `${base}/tasks`;
}
