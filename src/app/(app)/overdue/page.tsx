import type { Metadata } from "next";

import { TaskList } from "@/components/tasks/task-list";
import type { TaskClock } from "@/components/tasks/types";
import { Text } from "@/components/ui/text";
import { currentUserClock } from "@/lib/time/current-clock";

export const metadata: Metadata = {
  title: "Overdue",
};

/**
 * The derived bucket on its own.
 *
 * Nothing in the database is flagged "overdue". The condition — a deadline in
 * the past on a task that is not done — is evaluated on every read, in exactly
 * one place per side of the wire: `overdueCondition` in
 * `src/lib/db/repos/occurrences.ts` for SQL, `isOverdue()` in
 * `src/lib/tasks/overdue.ts` for the UI. That is why marking a task done, or
 * pushing its deadline out, empties it from this list on the very next load
 * with no background job and no invalidation step (criteria 10 and 11).
 *
 * The same tasks also appear in the Overdue group on `/today`. Not duplication:
 * that group is the nag you cannot avoid seeing, this page is where you sit
 * down and clear them. Both read the same query, so they cannot disagree.
 *
 * A task with **no** deadline never lands here however old it is (criterion 8).
 * An undated note is not late; it is just undated.
 *
 * Still a server component, for the same reason as its siblings: the clock is
 * read from `profiles.timezone` here and handed down, never taken in the
 * browser (criterion 19). It matters more here than anywhere else — "late" is
 * judged against a single instant, and two readings taken milliseconds apart
 * can disagree about a task whose deadline falls between them.
 */
export default async function OverduePage() {
  const clock: TaskClock = await currentUserClock();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-2">
        <Text variant="h1">Overdue</Text>
        <Text variant="body-sm" tone="secondary">
          Past its deadline and not finished. Nothing is stored as overdue — the
          list is worked out fresh each time you load it, so finishing a task or
          pushing its deadline out takes it off here immediately.
        </Text>
      </header>

      <TaskList view="overdue" clock={clock} />
    </div>
  );
}
