"use client";

import * as React from "react";

import { Text } from "@/components/ui/text";
import { PROGRESS_MAX, PROGRESS_MIN, clampProgress, formatProgress } from "@/lib/tasks/progress";
import { cn } from "@/lib/utils";

import { CONTROL_SIZE } from "./status-control";

/**
 * The progress control — a native `<input type="range">` and a live readout.
 *
 * ## Progress is set by hand and means nothing about status
 *
 * This control never consults the task's status and no status control ever
 * writes here. A `done` task sits at whatever percentage its owner left it at,
 * which is criterion 12 and a product decision: you mark something done because
 * you stopped working on it, and how far you got is the more interesting number.
 * `src/lib/tasks/progress.ts` enforces the same separation by refusing to import
 * `status.ts` at all.
 *
 * ## Why there is a draft value instead of a controlled prop
 *
 * React maps `onChange` on a range to the DOM's `input` event, which fires on
 * every pixel of a drag. Wiring that straight to a mutation would send fifty
 * writes for one gesture. So the thumb tracks local state and the *commit* —
 * pointer release, key release, blur — is what calls `onCommit`, once, and only
 * when the value actually moved. The readout follows the draft, so the number
 * under your finger is the number you are dragging to, not the last one saved.
 */

export interface ProgressControlProps {
  id: string;
  /** The saved value. The thumb re-seeds from it whenever it changes. */
  value: number;
  /** Called once per gesture, with the released value. */
  onCommit: (progressPct: number) => void;
  disabled?: boolean;
  /**
   * Accessible name for the slider. Rows and cards have no visible label; the
   * dialog omits it because `Field` supplies a real `<label>`.
   */
  label?: string;
  size?: keyof typeof CONTROL_SIZE;
  className?: string;
}

export function ProgressControl({
  id,
  value,
  onCommit,
  disabled,
  label,
  size = "default",
  className,
}: ProgressControlProps) {
  const [draft, setDraft] = React.useState(value);
  const [seeded, setSeeded] = React.useState(value);

  /**
   * Re-seed when the saved value changes — a successful mutation, a refetch, or
   * another tab. A drag in flight when a refetch lands is snapped back, which is
   * rare, brief, and the correct outcome anyway: the server's value is the one
   * that exists.
   *
   * Adjusted **during render** rather than in an effect. React documents this as
   * the way to react to a prop change ("You Might Not Need an Effect"): the
   * component re-renders immediately with the new value and the browser never
   * paints the stale one, whereas an effect paints the old position first and
   * then corrects it — a visible flicker on the thumb. It is also what the
   * compiler's `set-state-in-effect` rule is there to push you towards.
   */
  if (seeded !== value) {
    setSeeded(value);
    setDraft(value);
  }

  function commit() {
    if (draft !== value) onCommit(draft);
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <input
        id={id}
        name={id}
        type="range"
        min={PROGRESS_MIN}
        max={PROGRESS_MAX}
        step={1}
        value={draft}
        disabled={disabled}
        aria-label={label}
        // The readout is the visible value of this slider, so it is announced
        // instead of the raw number the platform would otherwise read out.
        aria-valuetext={formatProgress(draft)}
        onChange={(event) => setDraft(clampProgress(Number(event.target.value)))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className={cn(
          // `accent-accent` is Tailwind's `accent-color` utility pointed at the
          // brand token, which is how a native range is themed without
          // rebuilding the thumb and track by hand.
          "w-full min-w-20 cursor-pointer accent-accent disabled:cursor-not-allowed disabled:opacity-50",
          CONTROL_SIZE[size],
        )}
      />
      {/* `<output>` rather than a <span>: it is the element for "a value derived
          from other controls", and it announces changes without an aria-live
          attribute of our own. */}
      <Text
        variant="body-sm"
        tone="secondary"
        className="w-10 shrink-0 text-right tabular-nums"
        asChild
      >
        <output htmlFor={id}>{formatProgress(draft)}</output>
      </Text>
    </div>
  );
}
