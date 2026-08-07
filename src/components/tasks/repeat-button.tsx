"use client";

import { Repeat } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The repeat affordance, and the way into the rule editor — one control doing
 * both jobs.
 *
 * ## Criterion 13, stated as a component
 *
 * *"A recurring series appears in the Tasks list as one row per occurrence,
 * visually indistinguishable from a one-off except for a repeat affordance."*
 * So a recurring occurrence renders exactly like any other task and gains this
 * one small button beside its title. There is no collapsed series row, no second
 * read path, and no second set of status semantics for a thing that is not a
 * task.
 *
 * Making the affordance *also* the way to the editor is deliberate: two controls
 * ("Repeats" as a badge, "Edit series" as a button) would be two things to add
 * to both `task-row.tsx` and `task-card.tsx`, and two chances for the two
 * presentations to name them differently.
 *
 * ## The accessible name is the contract
 *
 * `Repeat rule of <title>` — the same string in the row and in the card,
 * exactly as `Edit <title>`, `Status of <title>` and `Progress of <title>`
 * already are. `AGENTS.md` records why: both presentations are always mounted
 * and CSS picks one, so a Playwright role query resolves to whichever is visible
 * and one line covers both projects. Renaming this in one file is a silent e2e
 * break in the other.
 */

export interface RepeatButtonProps {
  /** The occurrence's title — used to build the accessible name. */
  title: string;
  /** A one-line description of the rule, shown on hover. */
  summary?: string;
  onClick: () => void;
  disabled?: boolean;
}

export function RepeatButton({
  title,
  summary,
  onClick,
  disabled,
}: RepeatButtonProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 gap-1 px-1.5 text-xs"
      // Not the visible text. "Repeats" is what fits beside a title; the
      // accessible name has to say *which* task's rule this opens, because a
      // list has one of these per recurring row.
      aria-label={`Repeat rule of ${title}`}
      title={summary}
      disabled={disabled}
      onClick={onClick}
    >
      <Repeat aria-hidden="true" className="size-3" />
      Repeats
    </Button>
  );
}
