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
 * down" — no day filter, no derived bucket, just `task.list` newest day first.
 * It is the screen you use to find the thing you know you added last week.
 *
 * ## Why a server component for a list with no notion of "today"
 *
 * It has one. Rows date themselves relative to the current day, and the overdue
 * marker on a row is derived from a deadline against *now*, not read from a
 * stored flag. Both need the clock, and criterion 19 says the browser must not
 * be the one holding it — so it is read here from `profiles.timezone` and
 * passed down, exactly as on `/today`. A page that worked it out client-side
 * would hydrate into a different answer near midnight.
 */
export default async function TasksPage() {
  const clock: TaskClock = await currentUserClock();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <header className="space-y-2">
        <Text variant="h1">Tasks</Text>
        <Text variant="body-sm" tone="secondary">
          Every task on your account, whatever day it belongs to and whatever
          state it is in — newest day first.
        </Text>
      </header>

      <TaskList view="all" clock={clock} />
    </div>
  );
}
