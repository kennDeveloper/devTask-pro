import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

import type { TaskColumn } from "./task-presentation";

/**
 * Loading states for both presentations.
 *
 * AGENTS.md asks skeletons to **mirror the real layout** so resolving causes no
 * layout shift, and for a task list that means matching *heights*, not just cell
 * counts. A real row is as tall as the `h-9` status select inside it, so a row of
 * `h-4` shimmer bars — which is what `TableRowsSkeleton` produces — would be
 * twenty pixels short and the whole list would jump on the first render. So the
 * status and progress columns get `h-9` blocks, and the task column gets the two
 * lines a title-plus-notes cell actually has.
 *
 * The table skeleton is deliberately only the `<tbody>` contents: the caller
 * keeps the real `<TableHeader>` mounted throughout, so column titles, widths and
 * borders never move — only the rows pulse.
 */

/** Six rows: enough to read as a list, few enough not to imply a page count. */
const DEFAULT_ROWS = 6;

/** Alternating widths so the shimmer does not look mechanically ruled. */
const TITLE_WIDTHS = ["w-48", "w-56", "w-40", "w-52", "w-44", "w-56"];
const NOTE_WIDTHS = ["w-32", "w-24", "w-40", "w-28", "w-36", "w-20"];

export interface TaskTableSkeletonProps {
  columns: readonly TaskColumn[];
  rows?: number;
}

export function TaskTableSkeleton({
  columns,
  rows = DEFAULT_ROWS,
}: TaskTableSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, row) => (
        <TableRow key={row} data-slot="task-row-skeleton">
          {columns.map((column) => (
            <TableCell key={column.key} className={column.className}>
              {column.key === "task" ? (
                <div className="space-y-1.5">
                  <Skeleton className={`h-5 ${TITLE_WIDTHS[row % TITLE_WIDTHS.length]}`} />
                  <Skeleton className={`h-4 ${NOTE_WIDTHS[row % NOTE_WIDTHS.length]}`} />
                </div>
              ) : column.key === "status" || column.key === "progress" ? (
                // Matches the control that lands here, so the row does not
                // change height when the data arrives.
                <Skeleton className={`h-9 ${column.skeletonWidth}`} />
              ) : column.key === "actions" ? (
                <Skeleton className={`ml-auto h-9 ${column.skeletonWidth}`} />
              ) : (
                <Skeleton className={`h-5 ${column.skeletonWidth}`} />
              )}
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

export interface TaskCardListSkeletonProps {
  rows?: number;
}

/** The card presentation's own loading state — same padding, same stack. */
export function TaskCardListSkeleton({
  rows = DEFAULT_ROWS,
}: TaskCardListSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, row) => (
        <Card key={row} data-slot="task-card-skeleton" className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className={`h-5 ${TITLE_WIDTHS[row % TITLE_WIDTHS.length]}`} />
              <Skeleton className={`h-4 ${NOTE_WIDTHS[row % NOTE_WIDTHS.length]}`} />
            </div>
            <Skeleton className="h-9 w-14 shrink-0" />
          </div>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </Card>
      ))}
    </>
  );
}
