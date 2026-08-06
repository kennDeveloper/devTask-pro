import type { Metadata } from "next";
import Link from "next/link";
import { AlarmClock, Lock, Repeat } from "lucide-react";

import { Logo, PROJECT_NAME } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";

export const metadata: Metadata = {
  title: {
    absolute: `${PROJECT_NAME} — a private daily task tracker`,
  },
  description:
    "A private daily task tracker: your own list that nobody else sees, one-off and recurring tasks, and overdue handled for you.",
};

/**
 * The front door.
 *
 * One screen, restrained and typographic: what the product is, the three
 * things it does, the fact that accounts need approving, and two buttons.
 * No stock photography, no testimonials from people who do not exist, no
 * "10,000 tasks completed" counter measuring an empty database.
 *
 * The approval note is the load-bearing paragraph. Without it, signing up and
 * landing on /pending reads as a bug; with it, it reads as the product working
 * exactly as described.
 */
const FEATURES = [
  {
    icon: Lock,
    title: "One list, one person",
    body: "Every task belongs to exactly one account. Nobody else can read your list — that is enforced by the database on every query, not by a filter somebody has to remember to write.",
  },
  {
    icon: Repeat,
    title: "One-off and recurring",
    body: "Add something for today, or set it to come back — daily, weekly, or on the days you choose. Recurring items generate themselves; you never copy last week's list forward.",
  },
  {
    icon: AlarmClock,
    title: "Overdue without nagging",
    body: "Anything still open at the end of your day is marked overdue and stays where you can see it. No email chasers, no red badges on your phone.",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-4 px-6 py-5">
        <Logo size="md" variant="lockup" />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <Button variant="ghost" size="sm" asChild>
            <Link href="/sign-in">Sign in</Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-6 pb-20">
        <section className="space-y-6 pt-10 sm:pt-16">
          <Text variant="eyebrow">Daily task tracking</Text>
          <Text variant="display" balance>
            A private list for the work you actually do each day.
          </Text>
          <Text variant="lead" className="max-w-xl">
            {PROJECT_NAME} keeps one list per person. You add what needs doing,
            let the repeating things repeat, and see immediately what slipped.
            Nothing is shared, nothing is scored, and nobody is watching.
          </Text>

          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center">
            <Button size="lg" asChild>
              <Link href="/sign-up">Create an account</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/sign-in">Sign in</Link>
            </Button>
          </div>

          <Text variant="helper" className="block">
            Task tracking is still being built. Accounts, email confirmation and
            approval work today.
          </Text>
        </section>

        <Separator className="my-12" />

        <section aria-label="What it does" className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <Card key={title}>
              <CardHeader>
                <Icon
                  className="size-[18px] text-fg-4"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <CardTitle>{title}</CardTitle>
                <CardDescription>{body}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </section>

        <Separator className="my-12" />

        <section
          aria-label="Getting an account"
          className="max-w-xl space-y-3"
        >
          <Text variant="h3">Accounts are approved by hand</Text>
          <Text variant="body-sm" tone="secondary">
            Signing up sends you a confirmation email. Once you have confirmed
            the address, an administrator approves the account before it can be
            used — so after confirming you will see an &ldquo;awaiting
            approval&rdquo; screen for a while. That is the system working, not
            a failed sign-up.
          </Text>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-2 px-6 py-6">
          <Text variant="caption">{PROJECT_NAME}</Text>
          <Text variant="caption" className="ml-auto" asChild>
            <Link href="/sign-up" className="hover:text-ink">
              Create an account
            </Link>
          </Text>
        </div>
      </footer>
    </div>
  );
}
