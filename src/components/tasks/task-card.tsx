"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Text } from "@/components/ui/text";
import { isOverdue } from "@/lib/tasks/overdue";
import { cn } from "@/lib/utils";

import { ProgressControl } from "./progress-control";
import { StatusControl } from "./status-control";
import { dayLabel, formatDeadline } from "./task-presentation";
import { useTaskActions } from "./use-task-actions";

import type { TaskStatus } from "@/lib/db/schema";
import type { Task, TaskClock } from "./types";

/**
 * One task as a card — the presentation below `md`.
 *
 * AGENTS.md: lists on mobile are cards, never tables. A five-column table on a
 * 375px screen either scrolls sideways (so the status control is off-screen,
 * which is the control people reach for most) or wraps into an unreadable grid.
 *
 * The card holds **one flat piece of content**: a title block, a meta line, and
 * the two controls, all siblings. No nested bordered boxes and no labelled
 * sub-sections — if this ever needs a second grouping it becomes a second card.
 *
 * Overdue shifts the card's own hairline to `trip` and adds a badge, and — as in
 * `task-row.tsx` — the status control still shows the real `todo`/`in_progress`
 * beside it. Criterion 9 is about not letting "late" swallow "where is it up to".
 */

export interface TaskCardProps {
  task: Task;
  clock: TaskClock;
  /** `/today` scopes to one day, so repeating it on every card is noise. */
  showDay: boolean;
  onEdit: (task: Task) => void;
}

export function TaskCard({ task, clock, showDay, onEdit }: TaskCardProps) {
  const { update } = useTaskActions();
  const overdue = isOverdue(task, clock.now);

  function patch(fields: { status?: TaskStatus; progressPct?: number }) {
    update.mutate({ id: task.id, ...fields });
  }

  return (
    <Card
      data-slot="task-card"
      data-task-id={task.id}
      data-overdue={overdue ? "true" : undefined}
      className={cn("space-y-3 p-4", overdue && "border-trip/40")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Text variant="body-sm" weight="medium" className="block">
            {task.title}
          </Text>
          {task.description && (
            <Text variant="caption" className="mt-1 block">
              {task.description}
            </Text>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onEdit(task)}
          aria-label={`Edit ${task.title}`}
        >
          Edit
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {showDay && (
          <Text variant="caption">{dayLabel(task.occursOn, clock.today)}</Text>
        )}
        {task.deadlineAt && (
          <Text
            variant="caption"
            tone={overdue ? "destructive" : "muted"}
          >
            {showDay && <span aria-hidden="true">· </span>}
            Due {formatDeadline(task.deadlineAt, clock.timeZone)}
          </Text>
        )}
        {overdue && <Badge tone="danger">Overdue</Badge>}
      </div>

      <StatusControl
        id={`card-${task.id}-status`}
        label={`Status of ${task.title}`}
        value={task.status}
        size="sm"
        disabled={update.isPending}
        onChange={(status) => patch({ status })}
      />

      <ProgressControl
        id={`card-${task.id}-progress`}
        label={`Progress of ${task.title}`}
        value={task.progressPct}
        size="sm"
        disabled={update.isPending}
        onCommit={(progressPct) => patch({ progressPct })}
      />

      {/* Plain destructive text, not a tinted panel — a bordered box in here
          would be the nested section the card rule forbids. */}
      {update.isError && (
        <Text variant="body-sm" tone="destructive" role="alert">
          {update.error.message}
        </Text>
      )}
    </Card>
  );
}
