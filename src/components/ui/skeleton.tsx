import * as React from "react";
import { cn } from "@/lib/utils";
import { TableCell, TableRow } from "@/components/ui/table";

/** Fallback cell widths so skeleton rows don't look mechanically uniform. */
export const SKELETON_CELL_WIDTHS = [
  "w-32",
  "w-48",
  "w-20",
  "w-28",
  "w-24",
  "w-16",
] as const;

/**
 * Base shimmer block. One height (h-4) by default; resize via className.
 * Reach for this when no higher-level skeleton (TableRowsSkeleton, etc.)
 * fits — e.g. a heading placeholder, a card aside, an iframe stand-in.
 *
 * Loading states must MIRROR the real layout: same heights, same spacing,
 * same column widths, so resolving the data causes no layout shift.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("h-4 w-full animate-pulse rounded-md bg-paper-2", className)}
      {...props}
    />
  );
}

export interface TableRowsSkeletonProps {
  rows?: number;
  columns: number;
  /**
   * Optional Tailwind width classes, one per column. Useful when a column
   * holds a badge (narrow) or a long string (wide). Falls back to a varied
   * rotation so rows don't look mechanical.
   */
  cellWidths?: (string | undefined)[];
}

/**
 * Drop-in <TableBody> children that render N shimmer rows × M cells.
 * Pair with the real <TableHeader> so the column titles, widths and borders
 * stay stable while the data is loading — only the rows pulse.
 *
 * Usage:
 *   <Table>
 *     <TableHeader>…real headers…</TableHeader>
 *     <TableBody>
 *       {isLoading ? <TableRowsSkeleton rows={6} columns={5} /> : data.map(…)}
 *     </TableBody>
 *   </Table>
 */
export function TableRowsSkeleton({
  rows = 6,
  columns,
  cellWidths,
}: TableRowsSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r}>
          {Array.from({ length: columns }).map((__, c) => (
            <TableCell key={c}>
              <Skeleton
                className={
                  cellWidths?.[c] ??
                  SKELETON_CELL_WIDTHS[c % SKELETON_CELL_WIDTHS.length]
                }
              />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
