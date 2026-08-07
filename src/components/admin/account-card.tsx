"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
 * One account as a card — the presentation below `md`.
 *
 * AGENTS.md: lists on mobile are cards, never tables. A five-column table on a
 * 375px screen either scrolls sideways, which puts the action buttons off the
 * edge, or wraps into an unreadable grid.
 *
 * The card holds **one flat piece of content**: an identity block, a meta line,
 * and the controls, all siblings. No nested bordered boxes and no labelled
 * sub-sections — if this ever needs a second grouping it becomes a second card.
 *
 * The controls are the same `<AccountActions>` the row renders, so every button
 * here has byte-identical accessible naming to its desktop twin. That is not a
 * nicety: both trees are in the DOM at once and Playwright's role engine picks
 * the visible one, so a name that differs between them fails on exactly one
 * project and looks like flakiness.
 */

export interface AccountCardProps {
  account: Account;
  isSelf: boolean;
}

export function AccountCard({ account, isSelf }: AccountCardProps) {
  const secondary = accountSecondaryLine(account.displayName);

  return (
    <Card
      data-slot="account-card"
      data-account-id={account.id}
      className="space-y-3 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Text variant="body-sm" weight="medium" className="block break-all">
            {account.email}
          </Text>
          {secondary && (
            <Text variant="caption" className="mt-1 block">
              {secondary}
            </Text>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={accountStatusTone(account.status)}>
            {accountStatusLabel(account.status)}
          </Badge>
          {account.role === "admin" && <Badge tone="info">Admin</Badge>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Text variant="caption">
          Signed up {formatSignupDate(account.createdAt)}
        </Text>
        <Text variant="caption" tone="muted">
          <span aria-hidden="true">· </span>
          Last seen {formatLastSignIn(account.lastSignInAt)}
        </Text>
      </div>

      <AccountActions account={account} isSelf={isSelf} />
    </Card>
  );
}
