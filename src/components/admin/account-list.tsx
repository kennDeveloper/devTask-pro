"use client";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc/client";

import { AccountCard } from "./account-card";
import { ACCOUNT_COLUMNS } from "./account-presentation";
import { AccountsCardsEmpty, AccountsTableEmpty } from "./account-empty";
import { AccountRow } from "./account-row";
import {
  AccountsCardListSkeleton,
  AccountsTableSkeleton,
} from "./account-skeleton";

import type { Account, AdminViewer } from "./types";

/**
 * The account list: a table from `md` up, a stack of cards below it.
 *
 * ## Two presentations, four states
 *
 * AGENTS.md: *lists on mobile are cards, never tables*, and *both presentations
 * need their own loading and empty states*. Both trees are always rendered and
 * CSS picks one — which is also why `AccountRow` and `AccountCard` each mount
 * their own copy of `<AccountActions>` rather than sharing one instance from
 * here. The hidden copy costs a mutation subscription and nothing else, whereas
 * measuring the viewport in JavaScript to render only one would make the server
 * and the client disagree about what the page contains.
 *
 * ## Four states, four branches, and no skeleton that never resolves
 *
 * A failed query is not a slow one, so error and loading do not share a branch —
 * a skeleton left up after a failure claims the data is still on its way.
 *
 * `AccountListLayout` is everything after the data arrives and takes the query
 * as a plain object, so it renders in a test without a tRPC provider and the
 * loading, empty and error states are reachable by passing a value rather than
 * by intercepting a network call.
 *
 * ## What is deliberately not here
 *
 * No task column, no "open tasks" count, no chart. The admin tier governs access
 * and sees account metadata only. That is not an omission waiting to be filled:
 * `Account` has no task field to render because `routers/admin.ts` has none to
 * send because the repo's projection has none to fetch — three layers that would
 * all have to be changed on purpose. See criterion 6 in
 * `docs/gsd/devtask-pro-v1.md` before changing any of them.
 */

/**
 * The parts of a query this list reads.
 *
 * Narrower than react-query's result on purpose: it is the contract the layout
 * depends on and a test can supply it as an object literal.
 */
export interface AccountListQuery {
  data: Account[] | undefined;
  /** First load with nothing cached — the only state that earns a skeleton. */
  isPending: boolean;
  /** Any fetch in flight, including a retry. Drives the retry button's spinner. */
  isFetching: boolean;
  error: { message: string } | null;
  refetch: () => void;
}

export interface AccountListProps {
  /** The signed-in admin, resolved on the server. Marks their own row. */
  viewer: AdminViewer;
}

export function AccountList({ viewer }: AccountListProps) {
  const query = trpc.admin.list.useQuery();
  return <AccountListLayout viewer={viewer} query={query} />;
}

export interface AccountListLayoutProps {
  viewer: AdminViewer;
  query: AccountListQuery;
}

const LIST_LABEL = "Accounts";

export function AccountListLayout({
  viewer,
  query,
}: AccountListLayoutProps) {
  const accounts = query.data;
  const columnCount = ACCOUNT_COLUMNS.length;
  const isEmpty = !query.isPending && (accounts?.length ?? 0) === 0;

  if (query.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>The account list could not be loaded</CardTitle>
          <CardDescription>{query.error.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            loading={query.isFetching}
            onClick={() => query.refetch()}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* ---- md and up: the table ---- */}
      <div data-slot="account-table" className="hidden md:block">
        <Card className="overflow-hidden">
          {/* Named with `aria-label` rather than a `<caption>`: a caption is only
              valid as a table's first child and this one carries no visible text. */}
          <Table aria-label={LIST_LABEL}>
            {/* The real header stays mounted through loading, so column titles,
                widths and borders never move — only the rows pulse. */}
            <TableHeader>
              <TableRow>
                {ACCOUNT_COLUMNS.map((column) => (
                  <TableHead key={column.key} className={column.className}>
                    {column.labelHidden ? (
                      <span className="sr-only">{column.label}</span>
                    ) : (
                      column.label
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending ? (
                <AccountsTableSkeleton columns={ACCOUNT_COLUMNS} />
              ) : isEmpty ? (
                <AccountsTableEmpty columnCount={columnCount} />
              ) : (
                accounts?.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    isSelf={account.id === viewer.id}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* ---- below md: the cards ---- */}
      <div
        data-slot="account-cards"
        aria-label={LIST_LABEL}
        className="space-y-3 md:hidden"
      >
        {query.isPending ? (
          <AccountsCardListSkeleton />
        ) : isEmpty ? (
          <AccountsCardsEmpty />
        ) : (
          accounts?.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              isSelf={account.id === viewer.id}
            />
          ))
        )}
      </div>
    </div>
  );
}
