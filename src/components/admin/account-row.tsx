"use client";

import { Badge } from "@/components/ui/badge";
import { TableCell, TableRow } from "@/components/ui/table";
import { Text } from "@/components/ui/text";

import { AccountActions } from "./account-actions";
import {
  accountSecondaryLine,
  accountStatusLabel,
  accountStatusTone,
  formatLastSignIn,
  formatSignupDate,
} from "./account-presentation";

import type { Account } from "./types";

/**
 * One account as a table row. The `md`-and-up presentation; `account-card.tsx`
 * is the same account below that breakpoint.
 *
 * Both render the **same `<AccountActions>`**, which is what keeps their control
 * names identical without anybody having to remember to — see the long note in
 * that file.
 *
 * The email leads and the display name sits under it, not the other way round: a
 * display name is optional, is chosen by the account holder, and two people can
 * share one. The address is what the signup arrived as and what is unique, which
 * makes it both the honest identifier and the one Playwright can address a row
 * by without hitting strict mode.
 */

export interface AccountRowProps {
  account: Account;
  isSelf: boolean;
}

export function AccountRow({ account, isSelf }: AccountRowProps) {
  const secondary = accountSecondaryLine(account.displayName);

  return (
    <TableRow data-slot="account-row" data-account-id={account.id}>
      <TableCell className="max-w-xs">
        <Text variant="body-sm" weight="medium" className="block truncate">
          {account.email}
        </Text>
        {secondary && (
          <Text variant="caption" className="mt-0.5 block truncate">
            {secondary}
          </Text>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <Badge tone={accountStatusTone(account.status)}>
          {accountStatusLabel(account.status)}
        </Badge>
        {/* The role is shown only when it is the notable one. A "Member" pill on
            every row is a column of the same word. */}
        {account.role === "admin" && (
          <Badge tone="info" className="ml-1.5">
            Admin
          </Badge>
        )}
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <Text variant="body-sm" tone="secondary">
          {formatSignupDate(account.createdAt)}
        </Text>
      </TableCell>

      <TableCell className="whitespace-nowrap">
        <Text variant="body-sm" tone="secondary">
          {formatLastSignIn(account.lastSignInAt)}
        </Text>
      </TableCell>

      <TableCell>
        <AccountActions
          account={account}
          isSelf={isSelf}
          className="justify-end"
        />
      </TableCell>
    </TableRow>
  );
}
