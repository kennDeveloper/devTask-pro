"use client";

import { REMINDER_PRESETS, reminderLeadLabel } from "@/lib/tasks/reminder-lead";
import { cn } from "@/lib/utils";

import { CONTROL_SIZE } from "./status-control";

/**
 * The reminder lead control — a native `<select>`, same idiom as
 * `status-control.tsx` and for the same reason: there is still no Select
 * primitive in `src/components/ui`, and a second hand-rolled dropdown would
 * leave the app with two keyboard models and two focus rings.
 *
 * The options come from `REMINDER_PRESETS`, which lives in
 * `src/lib/tasks/reminder-lead.ts` beside the bounds it has to respect — so the
 * menu, the Zod schema and the `check` constraint cannot drift apart.
 *
 * ## `null` is a real option, not an absence
 *
 * "No reminder" is the default and the way back out, so it is the first entry
 * rather than an empty state. A `<select>` value is always a string, so `null`
 * travels as `NONE_VALUE` and is converted at this boundary — once, here, rather
 * than in each caller's `onChange`.
 *
 * ## A value the presets do not offer still renders
 *
 * A lead written through the API, or one a shorter future cadence allows, is
 * added to the menu rather than silently snapping the control to something the
 * user did not choose. `reminderLeadLabel` supplies the wording.
 */

/** A `<select>` cannot hold `null`; this is its spelling on the wire. */
const NONE_VALUE = "none";

export interface ReminderSelectProps {
  id: string;
  /** Minutes before the deadline, or `null` for no reminder. */
  value: number | null;
  onChange: (leadMinutes: number | null) => void;
  disabled?: boolean;
  /** Accessible name, for a caller with no visible `<label>`. */
  label?: string;
  size?: keyof typeof CONTROL_SIZE;
  className?: string;
}

export function ReminderSelect({
  id,
  value,
  onChange,
  disabled,
  label,
  size = "default",
  className,
}: ReminderSelectProps) {
  const options = optionsFor(value);

  return (
    <select
      id={id}
      name={id}
      value={value === null ? NONE_VALUE : String(value)}
      disabled={disabled}
      aria-label={label}
      onChange={(event) =>
        onChange(
          event.target.value === NONE_VALUE ? null : Number(event.target.value),
        )
      }
      className={cn(
        "w-full rounded-md border border-line bg-paper px-3 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
        CONTROL_SIZE[size],
        className,
      )}
    >
      {options.map((option) => (
        <option
          key={option.value === null ? NONE_VALUE : option.value}
          value={option.value === null ? NONE_VALUE : option.value}
        >
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The presets, plus `value` itself when it is not among them.
 *
 * Exported so `reminder-select.test.ts` can assert the widening without
 * rendering, and so the ordering rule lives in one testable place.
 */
export function optionsFor(
  value: number | null,
): readonly { value: number | null; label: string }[] {
  if (value === null || REMINDER_PRESETS.some((p) => p.value === value)) {
    return REMINDER_PRESETS;
  }

  // Inserted in order rather than appended, so the menu still reads shortest to
  // longest. "No reminder" is always first and never sorts.
  const [none, ...leads] = REMINDER_PRESETS;
  const widened = [...leads, { value, label: reminderLeadLabel(value) }].sort(
    (a, b) => (a.value ?? 0) - (b.value ?? 0),
  );

  return [none, ...widened];
}
