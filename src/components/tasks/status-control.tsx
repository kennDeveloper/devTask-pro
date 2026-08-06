"use client";

import { TASK_STATUS_OPTIONS } from "@/lib/tasks/status";
import { cn } from "@/lib/utils";

import type { TaskStatus } from "@/lib/db/schema";

/**
 * The status control — a native `<select>`.
 *
 * Same idiom as the time-zone control in `settings-screen.tsx`, deliberately:
 * there is still no Select primitive in `src/components/ui`, this task does not
 * own that directory, and a second hand-rolled dropdown would leave the app with
 * two select behaviours, two keyboard models and two focus rings. The classes
 * below mirror `Input`'s so the control lines up with every text field it sits
 * beside.
 *
 * The options come from `TASK_STATUS_OPTIONS`, which is derived from
 * `TASK_STATUSES` in the schema mirror — so a status added to the migration
 * appears here without an edit.
 *
 * **All three statuses are always offered.** Status is freely reversible: a task
 * marked `done` by mistake goes back to `in_progress` in one gesture. There is
 * no state machine and `nextStatus` is only the quick-toggle's affordance, not a
 * restriction on this control.
 */

/** Shared with `progress-control.tsx` so the two line up in a row. */
export const CONTROL_SIZE = {
  sm: "h-9",
  default: "h-11",
} as const;

export interface StatusControlProps {
  id: string;
  value: TaskStatus;
  onChange: (status: TaskStatus) => void;
  disabled?: boolean;
  /**
   * Accessible name. Rows and cards have no visible label, so they must pass
   * one; the dialog leaves it off because `Field` already labels the control and
   * an `aria-label` would silently win over that `<label>`.
   */
  label?: string;
  size?: keyof typeof CONTROL_SIZE;
  className?: string;
}

export function StatusControl({
  id,
  value,
  onChange,
  disabled,
  label,
  size = "default",
  className,
}: StatusControlProps) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as TaskStatus)}
      className={cn(
        "w-full rounded-md border border-line bg-paper px-3 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
        CONTROL_SIZE[size],
        className,
      )}
    >
      {TASK_STATUS_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
