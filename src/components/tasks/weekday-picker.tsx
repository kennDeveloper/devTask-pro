"use client";

import { WEEKDAY_OPTIONS } from "@/lib/recurrence/labels";
import { sortWeekdays } from "@/lib/recurrence/rule";
import { Text } from "@/components/ui/text";
import { cn } from "@/lib/utils";

import type { Weekday } from "@/lib/db/schema";

/**
 * The days a weekly rule fires on — seven toggles.
 *
 * ## Why checkboxes and not seven buttons
 *
 * It is a multi-select, and a checkbox is what the platform has for that: it
 * announces its own state, it is reachable with Tab and toggled with Space
 * without a keydown handler, and a screen reader hears "Monday, checked" rather
 * than "Monday" and a guess. The visible chip is CSS over a visually-hidden
 * input — `peer-checked:` does the styling, so there is no JavaScript deciding
 * what a pressed toggle looks like.
 *
 * ## Why a fieldset and not a `Field`
 *
 * `Field` labels one control through `htmlFor`. Seven inputs need a group label,
 * which is what `<legend>` is for — pointing a single `<label>` at one of the
 * seven would leave the other six unnamed in the accessibility tree.
 *
 * The error is rendered here rather than by a wrapper for the same reason: it
 * has to be associated with the group, not with the last checkbox in it.
 */

export interface WeekdayPickerProps {
  id: string;
  value: readonly Weekday[];
  onChange: (days: Weekday[]) => void;
  disabled?: boolean;
  error?: string;
}

export function WeekdayPicker({
  id,
  value,
  onChange,
  disabled,
  error,
}: WeekdayPickerProps) {
  function toggle(day: Weekday, checked: boolean) {
    // Sorted on the way out so two selections of the same days are the same
    // value — `normaliseRule` does this again on the server, but a UI that
    // reordered on click would make the preview line jump about.
    onChange(
      sortWeekdays(
        checked ? [...value, day] : value.filter((current) => current !== day),
      ),
    );
  }

  return (
    <fieldset
      className="space-y-2"
      aria-describedby={error ? `${id}-error` : undefined}
    >
      <Text variant="label" asChild>
        <legend>Repeat on</legend>
      </Text>

      <div className="flex flex-wrap gap-1.5">
        {WEEKDAY_OPTIONS.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label
              key={option.value}
              className="relative inline-flex cursor-pointer"
              // The full name for the pointer; the accessible name comes from
              // the input's own label text, which is the same word.
              title={option.label}
            >
              <input
                type="checkbox"
                // See the note in `src/components/tags/tag-picker.tsx`: an
                // `sr-only` input is clipped to the element's origin and the
                // visible toggle then intercepts every click.
                className="peer absolute inset-0 z-10 cursor-pointer opacity-0"
                name={`${id}-${option.value}`}
                checked={checked}
                disabled={disabled}
                aria-label={option.label}
                onChange={(event) => toggle(option.value, event.target.checked)}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-9 w-10 items-center justify-center rounded-md border border-line bg-paper text-sm text-fg-2 transition-colors",
                  "peer-checked:border-accent peer-checked:bg-accent-soft peer-checked:text-accent-deep peer-checked:font-medium",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-accent/25",
                  "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
                )}
              >
                {option.short}
              </span>
            </label>
          );
        })}
      </div>

      {error && (
        <Text variant="helper" tone="destructive" id={`${id}-error`} role="alert">
          {error}
        </Text>
      )}
    </fieldset>
  );
}
