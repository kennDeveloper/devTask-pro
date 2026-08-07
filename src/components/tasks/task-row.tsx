"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { isOverdue } from "@/lib/tasks/overdue";

import { ProgressControl } from "./progress-control";
import { RepeatButton } from "./repeat-button";
import { StatusControl } from "./status-control";
import { dayLabel, formatDeadline } from "./task-presentation";
import { useTaskActions } from "./use-task-actions";

import type { TaskStatus } from "@/lib/db/schema";
import type { Task, TaskClock } from "./types";

/**
 * One task as a table row. The `md`-and-up presentation; `task-card.tsx` is the
 * same task below that breakpoint.
 *
 * ## Overdue is shown *beside* the status, never instead of it
 *
 * Criterion 9: a late task must still say whether it is `todo` or `in_progress`.
 * So the two facts occupy different columns — the badge lives with the deadline
 * it is late against, and the status control shows the real status and stays
 * editable. Nothing recolours the status cell, and no code path derives one from
 * the other. `isOverdue` is asked, not re-implemented, and it is asked against
 * `clock.now` — the instant the server pinned for this render, so every list on
 * the page agrees about what "late" means.
 *
 * ## Both controls share one mutation
 *
 * Status and progress are separate patches but one in-flight state, so a row
 * being saved disables both. Two mutations would let a user drag the slider
 * while a status write is in flight and land the two writes in an order neither
 * of them chose.
 */

export interface TaskRowProps {
  task: Task;
  clock: TaskClock;
  /** Matches the header: `/today` drops the Day column, the other lists keep it. */
  showDay: boolean;
  /** Number of columns, for the error row's `colSpan`. */
  columnCount: number;
  onEdit: (task: Task) => void;
  /** Opens the repeat-rule editor. Only reachable on a recurring occurrence. */
  onEditSeries: (seriesId: string) => void;
}

export function TaskRow({
  task,
  clock,
  showDay,
  columnCount,
  onEdit,
  onEditSeries,
}: TaskRowProps) {
  const { update } = useTaskActions();
  const overdue = isOverdue(task, clock.now);

  function patch(fields: { status?: TaskStatus; progressPct?: number }) {
    update.mutate({ id: task.id, ...fields });
  }

  return (
    <>
      <TableRow
        data-slot="task-row"
        data-task-id={task.id}
        data-overdue={overdue ? "true" : undefined}
      >
        <TableCell className="max-w-xs">
          {/* Criterion 13: identical to a one-off but for the repeat button.
              Nothing else on the row changes — the status control, the progress
              slider and the overdue badge all behave exactly as they do for a
              task nobody generated. */}
          <div className="flex items-center gap-1.5">
            <Text variant="body-sm" weight="medium" className="block truncate">
              {task.title}
            </Text>
            {task.seriesId && (
              <RepeatButton
                title={task.title}
                onClick={() => onEditSeries(task.seriesId!)}
              />
            )}
          </div>
          {task.description && (
            <Text variant="caption" className="mt-0.5 block truncate">
              {task.description}
            </Text>
          )}
        </TableCell>

        {showDay && (
          <TableCell className="whitespace-nowrap">
            <Text variant="body-sm" tone="secondary">
              {dayLabel(task.occursOn, clock.today)}
            </Text>
          </TableCell>
        )}

        <TableCell className="whitespace-nowrap">
          {task.deadlineAt ? (
            <span className="flex items-center gap-2">
              <Text
                variant="body-sm"
                tone={overdue ? "destructive" : "secondary"}
              >
                {formatDeadline(task.deadlineAt, clock.timeZone)}
              </Text>
              {overdue && <Badge tone="danger">Overdue</Badge>}
            </span>
          ) : (
            <Text variant="body-sm" tone="faint" aria-label="No deadline">
              —
            </Text>
          )}
        </TableCell>

        <TableCell>
          <StatusControl
            id={`row-${task.id}-status`}
            label={`Status of ${task.title}`}
            value={task.status}
            size="sm"
            disabled={update.isPending}
            onChange={(status) => patch({ status })}
          />
        </TableCell>

        <TableCell>
          <ProgressControl
            id={`row-${task.id}-progress`}
            label={`Progress of ${task.title}`}
            value={task.progressPct}
            size="sm"
            disabled={update.isPending}
            onCommit={(progressPct) => patch({ progressPct })}
          />
        </TableCell>

        <TableCell className="text-right">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onEdit(task)}
            aria-label={`Edit ${task.title}`}
          >
            Edit
          </Button>
        </TableCell>
      </TableRow>

      {/* A failed inline save gets its own row rather than being squeezed into a
          cell: the message is a sentence, and a table cell that grows to hold one
          reflows every column beside it. */}
      {update.isError && (
        <TableRow data-slot="task-row-error">
          <TableCell colSpan={columnCount} className="pt-0">
            <Text variant="body-sm" tone="destructive" role="alert">
              {update.error.message}
            </Text>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
