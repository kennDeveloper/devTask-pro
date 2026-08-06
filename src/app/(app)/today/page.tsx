import type { Metadata } from "next";
import { AlarmClock, ListTodo, Repeat } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Text } from "@/components/ui/text";

export const metadata: Metadata = {
  title: "Today",
};

/**
 * The empty state that this build's home screen honestly is.
 *
 * No mocked task rows. Phase 1 exists to prove the access model — sign-up,
 * email confirmation, admin approval, and the row-level rules underneath — and
 * fake data here would misrepresent which of those things actually work. What
 * the screen does instead is name precisely what will occupy it, so the gap is
 * legible rather than mysterious.
 */
const COMING = [
  {
    icon: ListTodo,
    title: "One-off tasks",
    body: "Things you add for a particular day, tick off, and never see again.",
  },
  {
    icon: Repeat,
    title: "Recurring tasks",
    body: "Set once and they reappear on their own schedule — daily, weekly, or on the days you pick.",
  },
  {
    icon: AlarmClock,
    title: "Overdue, carried forward",
    body: "Anything still open when the day ends is marked overdue and stays visible instead of quietly disappearing.",
  },
];

export default function TodayPage() {
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <header className="space-y-2">
        <Text variant="h1">Today</Text>
        <Text variant="body-sm" tone="secondary">
          Your private list. Nobody else can see it — not other members, not by
          accident.
        </Text>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Task tracking arrives next</CardTitle>
          <CardDescription>
            This release builds the parts that have to be right before any task
            exists: accounts, email confirmation, admin approval, and the
            database rules that keep one person&rsquo;s list out of everyone
            else&rsquo;s. There is nothing to show here yet, and nothing is
            hidden from you.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-5">
            {COMING.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3">
                <Icon
                  className="mt-0.5 size-[18px] shrink-0 text-fg-4"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <div className="space-y-1">
                  <Text variant="label" asChild>
                    <span className="block">{title}</span>
                  </Text>
                  <Text variant="body-sm" tone="secondary">
                    {body}
                  </Text>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
