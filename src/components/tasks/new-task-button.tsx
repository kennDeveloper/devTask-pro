"use client";

import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";

import { TaskDialog } from "./task-dialog";

import type { TaskClock } from "./types";

/**
 * The create affordance: a button and the dialog it opens.
 *
 * The pair exists as one component so a page never has to hold dialog state of
 * its own — AGENTS.md keeps logic out of `src/app/**`, and "which modal is open"
 * is still logic. It also means the header button and the one inside an empty
 * state are the same component with the same behaviour, rather than two call
 * sites that drift.
 *
 * The dialog is mounted only while open. That is what re-seeds the form for each
 * new task: closing unmounts it, so the next open starts from
 * `initialTaskFormValues` again rather than from the last thing that was typed.
 */

export interface NewTaskButtonProps {
  /** Server-resolved; seeds the new task's day with the *user's* today. */
  clock: TaskClock;
  children?: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}

export function NewTaskButton({
  clock,
  children = "New task",
  variant = "primary",
  size,
  className,
}: NewTaskButtonProps) {
  const [open, setOpen] = React.useState(false);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        {children}
      </Button>
      {open && (
        <TaskDialog open clock={clock} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
