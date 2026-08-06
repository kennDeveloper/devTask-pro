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

/**
 * Where this empty state sits in the page's outline.
 *
 * It has to be told, because only the page knows: on `/today` the list is inside
 * a `<section>` already titled "Overdue" or "Today" at `h2`, so its message is a
 * level below that; on `/tasks` and `/overdue` the list *is* the page's content
 * under the `h1`, so the message is the `h2`. A constant here would either skip
 * a level on two pages or claim to be a sibling of its own section heading on
 * the third.
 */
export type EmptyHeadingLevel = "h2" | "h3";

export interface TaskEmptyCopy {
  title: string;
  body: string;
  headingLevel: EmptyHeadingLevel;
}

export interface TaskTableEmptyProps extends TaskEmptyCopy {
  /** Spans the full width, so the message is centred under the header rather than in column one. */
  columnCount: number;
}

export function TaskTableEmpty({
  columnCount,
  title,
  body,
  headingLevel,
}: TaskTableEmptyProps) {
  return (
    <TableRow data-slot="task-table-empty" className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="py-14 text-center">
        <EmptyMessage title={title} body={body} headingLevel={headingLevel} />
      </TableCell>
    </TableRow>
  );
}

export function TaskCardsEmpty({ title, body, headingLevel }: TaskEmptyCopy) {
  return (
    <Card data-slot="task-cards-empty" className="p-8 text-center">
      <EmptyMessage title={title} body={body} headingLevel={headingLevel} />
    </Card>
  );
}

/**
 * Flat by construction — a heading and a line. No panel, no nested box.
 *
 * The title is a **real heading**, not a paragraph styled like one. It reads as
 * the title of the list either way, so marking it up as anything else hides it
 * from heading navigation — the one way a screen-reader user skims a page — and
 * leaves them to find "why is this list empty" by reading through it. It also
 * gives the state a name a test can ask for by role, which matters more than it
 * sounds: both presentations are always in the DOM, so plain text matches the
 * hidden copy too, while a role only ever resolves to the visible one.
 */
function EmptyMessage({ title, body, headingLevel }: TaskEmptyCopy) {
  return (
    <div className="mx-auto max-w-sm space-y-2">
      <Text variant="h4" as={headingLevel}>
        {title}
      </Text>
      <Text variant="body-sm" tone="muted">
        {body}
      </Text>
    </div>
  );
}
