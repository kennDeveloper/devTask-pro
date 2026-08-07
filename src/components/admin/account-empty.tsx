import { Card } from "@/components/ui/card";
import { TableCell, TableRow } from "@/components/ui/table";
import { Text } from "@/components/ui/text";

/**
 * The empty states — one per presentation, sharing their copy.
 *
 * AGENTS.md is explicit that a table and its mobile card list each need their
 * own loading *and* empty states: a `<Card>` cannot live inside a `<tbody>`, and
 * a `colSpan` row is not something the card list has. What they must not have is
 * two different sentences, so the copy is defined once here and both read it.
 *
 * The title is a **real heading**, not a paragraph styled like one. It reads as
 * the title of the list either way, so marking it up as anything else hides it
 * from heading navigation and denies the state a name a test can ask for by
 * role — which matters more than it sounds, because both presentations are
 * always in the DOM and plain text matches the hidden copy too, while a role
 * only ever resolves to the visible one.
 */

export const ACCOUNTS_EMPTY_TITLE = "No accounts yet";

/**
 * Deliberately calm and non-actionable. There is no button to add an account:
 * people arrive by signing up, and the bootstrap admin is created by
 * `pnpm admin:create`. An empty state that offered a control the tier does not
 * have would be a lie about the product.
 */
export const ACCOUNTS_EMPTY_BODY =
  "Nobody has signed up yet. New accounts arrive here awaiting a decision, newest waiting first.";

export interface AccountsTableEmptyProps {
  /** Spans the full width, so the message is centred under the header. */
  columnCount: number;
}

export function AccountsTableEmpty({ columnCount }: AccountsTableEmptyProps) {
  return (
    <TableRow data-slot="accounts-table-empty" className="hover:bg-transparent">
      <TableCell colSpan={columnCount} className="py-14 text-center">
        <EmptyMessage />
      </TableCell>
    </TableRow>
  );
}

export function AccountsCardsEmpty() {
  return (
    <Card data-slot="accounts-cards-empty" className="p-8 text-center">
      <EmptyMessage />
    </Card>
  );
}

/** Flat by construction — a heading and a line. No panel, no nested box. */
function EmptyMessage() {
  return (
    <div className="mx-auto max-w-sm space-y-2">
      <Text variant="h4" as="h2">
        {ACCOUNTS_EMPTY_TITLE}
      </Text>
      <Text variant="body-sm" tone="muted">
        {ACCOUNTS_EMPTY_BODY}
      </Text>
    </div>
  );
}
