"use client";

import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

/**
 * Choosing which tags a task or a series carries.
 *
 * ## Checkboxes, for the reason `weekday-picker.tsx` gives
 *
 * It is a multi-select, and a checkbox is what the platform has for that: it
 * announces its own state, it is reachable with Tab and toggled with Space
 * without a keydown handler, and a screen reader hears "Work, checked" rather
 * than "Work" and a guess. The visible chip is CSS over a visually-hidden input,
 * so nothing in JavaScript decides what a selected tag looks like.
 *
 * ## A `<fieldset>`, not a `Field`
 *
 * `Field` labels one control through `htmlFor`. A group of them needs a
 * `<legend>` — pointing a single `<label>` at one checkbox would leave the rest
 * unnamed in the accessibility tree.
 *
 * ## Why it fetches rather than being handed the list
 *
 * Both dialogs need the same list and neither owns it, and the query is cached
 * by tRPC — so mounting two pickers on one page costs one request, not two. The
 * empty state points at Settings rather than offering inline creation: a tag
 * created mid-task-edit is a tag nobody names carefully.
 */

export interface TagPickerProps {
  id: string;
  /** Currently selected tag ids. */
  value: readonly string[];
  onChange: (tagIds: string[]) => void;
  disabled?: boolean;
  /** The `<legend>`. Differs between "this task" and "every occurrence". */
  legend?: string;
}

export function TagPicker({
  id,
  value,
  onChange,
  disabled,
  legend = "Tags",
}: TagPickerProps) {
  const query = trpc.tag.list.useQuery();
  const tags = query.data ?? [];

  function toggle(tagId: string, checked: boolean) {
    onChange(
      checked ? [...value, tagId] : value.filter((current) => current !== tagId),
    );
  }

  return (
    <fieldset className="space-y-2">
      <Text variant="label" asChild>
        <legend>{legend}</legend>
      </Text>

      {query.isPending ? (
        <Text variant="helper">Loading your tags…</Text>
      ) : tags.length === 0 ? (
        <Text variant="helper">
          You have no tags yet. Create them in Settings.
        </Text>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => {
            const checked = value.includes(tag.id);
            return (
              <label key={tag.id} className="cursor-pointer">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  name={`${id}-${tag.id}`}
                  checked={checked}
                  disabled={disabled}
                  aria-label={tag.name}
                  onChange={(event) => toggle(tag.id, event.target.checked)}
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex rounded-full outline-offset-2 transition-opacity",
                    // Unselected tags are dimmed rather than recoloured, so the
                    // chip in the picker is recognisably the chip on the row.
                    !checked && "opacity-40",
                    "peer-focus-visible:outline-2 peer-focus-visible:outline-accent",
                    "peer-disabled:cursor-not-allowed peer-disabled:opacity-25",
                  )}
                >
                  <Badge tone={tag.color}>{tag.name}</Badge>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
