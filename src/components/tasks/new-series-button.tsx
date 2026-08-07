"use client";

import * as React from "react";

import { Button, type ButtonProps } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { trpc } from "@/lib/trpc/client";

import { SeriesDialog } from "./series-dialog";

import type { TaskClock } from "./types";

/**
 * The two ways into the repeat-rule editor: a create button, and a loader that
 * fetches one series and opens the editor on it.
 *
 * They live together because they wrap the same dialog and differ only in where
 * the seed values come from — and because a page should never have to hold
 * "which modal is open" state of its own (AGENTS.md keeps logic out of
 * `src/app/**`, and that is still logic).
 */

export interface NewSeriesButtonProps {
  /** Server-resolved; seeds the rule's start date with the *user's* today. */
  clock: TaskClock;
  children?: React.ReactNode;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
}

export function NewSeriesButton({
  clock,
  children = "New repeating task",
  variant = "outline",
  size,
  className,
}: NewSeriesButtonProps) {
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
      {/* Mounted only while open, which is what re-seeds the form for each new
          rule: closing unmounts it, so the next open starts from
          `initialSeriesFormValues` rather than from the last thing typed. */}
      {open && (
        <SeriesDialog open clock={clock} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export interface EditSeriesDialogProps {
  seriesId: string;
  clock: TaskClock;
  onClose: () => void;
}

/**
 * Load one series, then open the editor on it.
 *
 * ## Why the fetch is a separate component from the dialog
 *
 * `SeriesDialog` seeds its form state in `useState`'s initialiser, once, at
 * mount — which is what stops a refetch landing mid-edit and overwriting what
 * the user typed. That only works if it mounts with the data already in hand, so
 * the query lives out here and the dialog is not rendered until it resolves.
 *
 * ## Why the rule is fetched rather than carried on the row
 *
 * A row is a `Task`; it knows its `seriesId` and nothing else about the rule.
 * Widening the task payload to carry ten rule fields on every occurrence would
 * repeat the same rule down a whole list to serve a dialog most rows never open.
 */
export function EditSeriesDialog({
  seriesId,
  clock,
  onClose,
}: EditSeriesDialogProps) {
  const query = trpc.series.get.useQuery({ id: seriesId });

  if (query.data) {
    return (
      <SeriesDialog open clock={clock} series={query.data} onClose={onClose} />
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="Repeat rule"
      description={
        query.error ? query.error.message : "Loading this task's repeat rule."
      }
    >
      {/* A skeleton mirroring the real form's first fields, so resolving does
          not jolt the dialog's height. Not shown at all once the query has
          failed — a skeleton that never resolves claims the data is still on
          its way. */}
      {!query.error && (
        <div className="space-y-5">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-20 w-full" />
          <div className="grid gap-5 sm:grid-cols-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </div>
      )}
    </Dialog>
  );
}
