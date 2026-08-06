import type { Metadata } from "next";

import { TaskList } from "@/components/tasks/task-list";
import type { TaskClock } from "@/components/tasks/types";
import { Text } from "@/components/ui/text";
import { currentUserClock } from "@/lib/time/current-clock";

export const metadata: Metadata = {
  title: "Today",
};

/**
 * The home screen: **overdue above today**, deliberately.
 *
 * This was decided as a product question, not a layout one. A daily tracker
 * whose main screen shows only work dated today quietly buries everything that
 * slipped — which is precisely the work that needed the reminder. So the stale
 * items sit first, and the day's list follows.
 *
 * `/overdue` still exists as its own destination, and a task appears in both
 * places at once. That is intended: the group here is the nag, the page there
 * is the backlog you go and work through. Neither holds a copy of the other's
 * state — both are derived from the same query on every load, so finishing a
 * task clears it from both at the same moment (criteria 10 and 11).
 *
 * ## Why this is a server component
 *
 * Criterion 19. The clock is read here, in the account holder's timezone, and
 * handed down as data. The client is never asked what day it is — a
 * `new Date()` in the browser cannot agree with the server by construction
 * (different clocks, different instants, and around midnight different
 * answers), and the visible symptom is a flash of the wrong day immediately
 * after hydration.
 *
 * The annotation on `clock` is load-bearing rather than decorative: it is what
 * makes the compiler check that what `src/lib/time/current-clock.ts` produces
 * still satisfies the shape `src/components/tasks/` expects, instead of the two
 * drifting behind structural typing.
 */
export default async function TodayPage() {
  const clock: TaskClock = await currentUserClock();

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8">
      <header className="space-y-2">
        <Text variant="h1">Today</Text>
        <Text variant="body-sm" tone="secondary">
          Your private list. Nobody else can see it — not other members, not by
          accident.
        </Text>
      </header>

      {/* `variant="h3"` for the size, `as="h2"` for the outline: these are the
          second level of the document under the page's h1, and someone walking
          the headings with a screen reader should hear that, even though
          visually they only need to be one step down from the title. */}
      <section aria-labelledby="today-overdue-heading" className="space-y-3">
        <div className="space-y-1">
          <Text variant="h3" as="h2" id="today-overdue-heading">
            Overdue
          </Text>
          <Text variant="body-sm" tone="secondary">
            Past its deadline and still open. It sits above the day&rsquo;s list
            because a tracker that hides slipped work on the screen you actually
            open has failed at the job you opened it for.
          </Text>
        </div>
        {/* `h3`: this list lives inside a section already titled "Overdue" at
            `h2`, so its empty state is a level below that rather than a sibling
            of the heading it sits under. `/overdue` renders the same view as a
            whole page and takes the default. */}
        <TaskList view="overdue" clock={clock} headingLevel="h3" />
      </section>

      <section aria-labelledby="today-day-heading" className="space-y-3">
        <div className="space-y-1">
          <Text variant="h3" as="h2" id="today-day-heading">
            Today
          </Text>
          <Text variant="body-sm" tone="secondary">
            Dated today in the time zone on your profile — not this
            server&rsquo;s and not this browser&rsquo;s. Change it in Settings
            and the boundary moves with you.
          </Text>
        </div>
        <TaskList view="day" clock={clock} headingLevel="h3" />
      </section>
    </div>
  );
}
