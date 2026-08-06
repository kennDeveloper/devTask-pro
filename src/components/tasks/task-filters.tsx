"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { TASK_STATUS_OPTIONS } from "@/lib/tasks/status";
import { hasAnyFilter, type TaskFilters } from "@/lib/tasks/filters";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

import type { TaskStatus } from "@/lib/db/schema";

/**
 * The search box and the three filters.
 *
 * ## State lives here, and the filtering happens on the server
 *
 * The client sends criteria, never a predicate — so a filtered list is the same
 * query with a `where`, and the projections of a repeat rule are filtered by the
 * same definition (see `src/lib/tasks/filters.ts`). A client-side `.filter()`
 * over whatever happened to be fetched would silently disagree with it.
 *
 * ## Why the state is not in the URL
 *
 * A shareable filtered link would be nicer, and it would mean reading
 * `searchParams` during SSR and having that value agree with what the client
 * re-renders — the same class of server/client disagreement the `TaskClock`
 * arrangement exists to prevent, bought for something v1 does not ask for. Saved
 * searches are explicitly out of scope, so nothing downstream depends on it.
 *
 * ## The search is debounced, the rest are not
 *
 * Typing produces a keystroke every ~100ms and each one would be a query. The
 * selects and dates change once per decision, so they apply immediately —
 * debouncing those would only make the list feel unresponsive.
 */

/** Long enough to finish a word, short enough to feel immediate. */
const SEARCH_DEBOUNCE_MS = 250;

export interface TaskFiltersBarProps {
  value: TaskFilters;
  onChange: (filters: TaskFilters) => void;
}

export function TaskFiltersBar({ value, onChange }: TaskFiltersBarProps) {
  const tagQuery = trpc.tag.list.useQuery();
  const tags = tagQuery.data ?? [];

  /**
   * The search box keeps its own immediate value so typing never lags, and
   * pushes upward on a timer.
   */
  const [draft, setDraft] = React.useState(value.search ?? "");
  const committed = value.search ?? "";

  /**
   * Follow the committed value when the *parent* changes it — which happens on
   * Clear, and only there.
   *
   * Adjusted **during render** rather than in an effect, which is the pattern
   * `progress-control.tsx` already uses and explains: React documents it as the
   * way to react to a prop change, the component re-renders immediately with the
   * new value, and the browser never paints the stale one. An effect would paint
   * the old text first and then correct it.
   */
  const [seeded, setSeeded] = React.useState(committed);
  if (seeded !== committed) {
    setSeeded(committed);
    setDraft(committed);
  }

  React.useEffect(() => {
    if (draft === committed) return;

    const timer = setTimeout(() => {
      onChange({ ...value, search: draft });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // `value` and `onChange` are deliberately absent: including them restarts
    // the timer whenever the parent re-renders, which for a debounce means it
    // never fires. `draft` changing is the only thing that should restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, committed]);

  function toggleStatus(status: TaskStatus, checked: boolean) {
    const current = value.statuses ?? [];
    onChange({
      ...value,
      statuses: checked
        ? [...current, status]
        : current.filter((entry) => entry !== status),
    });
  }

  function toggleTag(tagId: string, checked: boolean) {
    const current = value.tagIds ?? [];
    onChange({
      ...value,
      tagIds: checked
        ? [...current, tagId]
        : current.filter((entry) => entry !== tagId),
    });
  }

  const filtering = hasAnyFilter(value);

  return (
    <div
      // A `search` landmark, so the whole bar is one thing to skip past rather
      // than six loose controls between the heading and the list.
      role="search"
      aria-label="Filter tasks"
      className="space-y-3 rounded-lg border border-line bg-paper p-3"
    >
      {/* One column below md, a row above it. */}
      <div className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Text variant="label" asChild>
            <label htmlFor="task-filter-search">Search</label>
          </Text>
          <Input
            id="task-filter-search"
            type="search"
            placeholder="Search titles"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        <div className="flex gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <Text variant="label" asChild>
              <label htmlFor="task-filter-from">From</label>
            </Text>
            <Input
              id="task-filter-from"
              type="date"
              value={value.from ?? ""}
              onChange={(event) =>
                onChange({ ...value, from: event.target.value || undefined })
              }
            />
          </div>

          <div className="min-w-0 flex-1 space-y-1.5">
            <Text variant="label" asChild>
              <label htmlFor="task-filter-to">To</label>
            </Text>
            <Input
              id="task-filter-to"
              type="date"
              value={value.to ?? ""}
              onChange={(event) =>
                onChange({ ...value, to: event.target.value || undefined })
              }
            />
          </div>
        </div>
      </div>

      <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Text variant="label" asChild>
          <legend className="mr-1">Status</legend>
        </Text>
        {TASK_STATUS_OPTIONS.map((option) => (
          <label key={option.value} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={(value.statuses ?? []).includes(option.value)}
              onChange={(event) =>
                toggleStatus(option.value, event.target.checked)
              }
            />
            <Text variant="body-sm">{option.label}</Text>
          </label>
        ))}
      </fieldset>

      {tags.length > 0 && (
        <fieldset className="space-y-1.5">
          <Text variant="label" asChild>
            <legend>Tags</legend>
          </Text>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const checked = (value.tagIds ?? []).includes(tag.id);
              return (
                <label key={tag.id} className="cursor-pointer">
                  <input
                    type="checkbox"
                    className="peer sr-only"
                    checked={checked}
                    // Distinct from the picker's plain `<tag name>`: a page can
                    // show both, and two controls sharing an accessible name is
                    // a strict-mode failure waiting for the e2e suite.
                    aria-label={`Filter by ${tag.name}`}
                    onChange={(event) => toggleTag(tag.id, event.target.checked)}
                  />
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex rounded-full outline-offset-2 transition-opacity",
                      !checked && "opacity-40",
                      "peer-focus-visible:outline-2 peer-focus-visible:outline-accent",
                    )}
                  >
                    <Badge tone={tag.color}>{tag.name}</Badge>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      )}

      {filtering && (
        <Button
          variant="outline"
          size="sm"
          // Resets to `{}` rather than clearing field by field, so "cleared" is
          // exactly the value the unfiltered list started from — which is what
          // makes criterion 10 structural rather than something to test for.
          onClick={() => onChange({})}
        >
          Clear filters
        </Button>
      )}
    </div>
  );
}
