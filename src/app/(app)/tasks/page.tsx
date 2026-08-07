import type { Metadata } from "next";

import { TaskList } from "@/components/tasks/task-list";
import type { TaskClock } from "@/components/tasks/types";
import { Text } from "@/components/ui/text";
import { currentUserClock } from "@/lib/time/current-clock";

export const metadata: Metadata = {
  title: "Tasks",
};

/**
 * Everything you own, in one list.
 *
 * `/today` answers "what am I doing now"; this answers "what did I write
 * down" — no day filter and no derived bucket. It is the screen you use to find
 * the thing you know you added last week.
 *
 * ## What "everything" means now that repeat rules exist
 *
 * A recurring task appears here as **one row per occurrence**, not as a
 * collapsed series row: a row is a task whether or not a rule produced it, which
 * is the one-read-path decision the whole schema is built around. Occurrences
 * nobody has touched are projected from the rule at read time and bounded to a
 * window around today; occurrences carrying recorded work are rows and are not
 * bounded at all, so a one-off from last year is still here.
 * `src/lib/tasks/feed.ts` explains why the record and the projection get
 * different treatment.
 *
 * ## Why a server component for a list with no notion of "today"
 *
 * It has one, and now two. Rows date themselves relative to the current day and
 * the overdue marker is derived from a deadline against *now*; on top of that,
 * the expansion window is derived from the account holder's today. Criterion 19
 * says the browser must not be the one holding either — so the clock is read
 * here from `profiles.timezone` and passed down, exactly as on `/today`. A page
 * that worked it out client-side would hydrate into a different answer near
 * midnight.
 */
export default async function TasksPage() {
  const clock: TaskClock = await currentUserClock();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-2">
        <Text variant="h1">Tasks</Text>
        <Text variant="body-sm" tone="secondary">
          Every task on your account, whatever day it belongs to and whatever
          state it is in — newest day first. A repeating task shows up once per
          date it falls on, and each one keeps its own status and progress.
        </Text>
      </header>

      <TaskList view="all" clock={clock} />
    </div>
  );
}
