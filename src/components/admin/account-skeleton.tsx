import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

import type { AccountColumn } from "./account-presentation";

/**
 * Loading states for both presentations.
 *
 * AGENTS.md asks skeletons to **mirror the real layout** so resolving causes no
 * layout shift, and for this list that means matching *heights*, not just cell
 * counts. A real row is as tall as the `h-9` action buttons inside it, so the
 * generic `TableRowsSkeleton` — which emits `h-4` bars — would be twenty pixels
 * short and the whole table would jump on first render. So the actions column
 * gets `h-9` blocks and the account column gets the two lines an
 * email-plus-name cell actually has.
 *
 * The table skeleton is deliberately only the `<tbody>` contents: the caller
 * keeps the real `<TableHeader>` mounted throughout, so column titles, widths
 * and borders never move — only the rows pulse.
 */

/** Six rows: enough to read as a list, few enough not to imply a page count. */
const DEFAULT_ROWS = 6;

/** Alternating widths so the shimmer does not look mechanically ruled. */
const EMAIL_WIDTHS = ["w-48", "w-56", "w-40", "w-52", "w-44", "w-56"];
const NAME_WIDTHS = ["w-32", "w-24", "w-40", "w-28", "w-36", "w-20"];

export interface AccountsTableSkeletonProps {
  columns: readonly AccountColumn[];
  rows?: number;
}

export function AccountsTableSkeleton({
  columns,
  rows = DEFAULT_ROWS,
}: AccountsTableSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, row) => (
        <TableRow key={row} data-slot="account-row-skeleton">
          {columns.map((column) => (
            <TableCell key={column.key} className={column.className}>
              {column.key === "account" ? (
                <div className="space-y-1.5">
                  <Skeleton
                    className={`h-5 ${EMAIL_WIDTHS[row % EMAIL_WIDTHS.length]}`}
                  />
                  <Skeleton
                    className={`h-4 ${NAME_WIDTHS[row % NAME_WIDTHS.length]}`}
                  />
                </div>
              ) : column.key === "actions" ? (
                // Matches the button row that lands here, so the row does not
                // change height when the data arrives.
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

export interface AccountsCardListSkeletonProps {
  rows?: number;
}

/** The card presentation's own loading state — same padding, same stack. */
export function AccountsCardListSkeleton({
  rows = DEFAULT_ROWS,
}: AccountsCardListSkeletonProps) {
  return (
    <>
      {Array.from({ length: rows }).map((_, row) => (
        <Card
          key={row}
          data-slot="account-card-skeleton"
          className="space-y-3 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton
                className={`h-5 ${EMAIL_WIDTHS[row % EMAIL_WIDTHS.length]}`}
              />
              <Skeleton
                className={`h-4 ${NAME_WIDTHS[row % NAME_WIDTHS.length]}`}
              />
            </div>
            <Skeleton className="h-5 w-16 shrink-0" />
          </div>
          <Skeleton className="h-4 w-52" />
          <Skeleton className="h-9 w-full" />
        </Card>
      ))}
    </>
  );
}
