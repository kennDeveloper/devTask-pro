import { Card } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { Text } from "@/components/ui/text";

/**
 * The empty states — one per presentation, sharing their copy.
 *
 * AGENTS.md is explicit that a table and its mobile card list each need their
 * own loading *and* empty states: a `<Card>` cannot live inside a `<tbody>`, and
 * a `colSpan` row is not something the card list has. What they must not have is
 * two different sentences, so the copy arrives as props from one call site —
 * `VIEWS` in `task-list.tsx`, which is also where it is decided how loud the
 * message should be.
 *
 * Neither carries an action. The "New task" button sits above the list for the
 * views that offer one, so putting a second copy inside the empty state would
 * show the same button twice on the only screen where it is easy to find.
 */

export interface TaskEmptyCopy {
  title: string;
  body: string;
}

export interface TaskTableEmptyProps extends TaskEmptyCopy {
  /** Spans the full width, so the message is centred under the header rather than in column one. */
  columnCount: number;
}

export function TaskTableEmpty({ columnCount, title, body }: TaskTableEmptyProps) {
  return (
    <TableRow data-slot="task-table-empty" className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="py-14 text-center">
        <EmptyMessage title={title} body={body} />
      </TableCell>
    </TableRow>
  );
}

export function TaskCardsEmpty({ title, body }: TaskEmptyCopy) {
  return (
    <Card data-slot="task-cards-empty" className="p-8 text-center">
      <EmptyMessage title={title} body={body} />
    </Card>
  );
}

/** Flat by construction — a heading and a line. No panel, no nested box. */
function EmptyMessage({ title, body }: TaskEmptyCopy) {
  return (
    <div className="mx-auto max-w-sm space-y-2">
      <Text variant="h4" as="p">
        {title}
      </Text>
      <Text variant="body-sm" tone="muted">
        {body}
      </Text>
    </div>
  );
}
