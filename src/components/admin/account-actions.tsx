"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import {
  ADMIN_ACTION_SPECS,
  actionsFor,
  type AdminAction,
} from "@/lib/admin/transitions";
import { cn } from "@/lib/utils";

import {
  RESET_PASSWORD_LABEL,
  actionControlName,
  resetControlName,
} from "./account-presentation";
import { ConfirmActionDialog } from "./confirm-action-dialog";
import { useAccountActions } from "./use-account-actions";

import type { Account } from "./types";

/**
 * Every control that acts on one account, in one component.
 *
 * ## This component exists because of an e2e rule
 *
 * AGENTS.md, on the task list: *"rows and cards name their controls
 * identically — `Edit <title>`, `Status of <title>` … `task-row.tsx` and
 * `task-card.tsx` must stay in step; renaming in one is a silent e2e break in
 * the other."* That is a real hazard: both presentations are in the DOM at once,
 * Playwright's role engine resolves to whichever is displayed, and a name
 * changed in only one file fails on one project and passes on the other.
 *
 * Phase 2 could only forbid the drift. Here it is made impossible: `AccountRow`
 * and `AccountCard` both render **this**, and the names come from
 * `actionControlName()`, so there is exactly one place any of them is spelled.
 * If you are about to copy a button into either of those files, put it here
 * instead.
 *
 * ## Which buttons appear is the transition table's decision
 *
 * `actionsFor(status)` — a pending row offers Approve and Reject, an active one
 * offers Suspend, and neither offers something the server would then refuse. The
 * server re-decides it anyway (`canApply` in `routers/admin.ts`); this is the
 * courtesy, not the boundary.
 *
 * ## The admin's own row has no buttons
 *
 * Also a courtesy. `routers/admin.ts` refuses a self-targeted action whatever
 * the client sends, because hiding a control is presentation and criterion 10
 * asks for a guarantee.
 */

export interface AccountActionsProps {
  account: Account;
  /** True when this row is the signed-in admin. Controls are withheld. */
  isSelf: boolean;
  /**
   * `justify-end` on a table row, `justify-start` on a card. Layout only — the
   * buttons and their names are identical either way, which is the whole point.
   */
  className?: string;
}

export function AccountActions({
  account,
  isSelf,
  className,
}: AccountActionsProps) {
  const { setStatus, sendPasswordReset } = useAccountActions();
  const [confirming, setConfirming] = React.useState<AdminAction | null>(null);

  if (isSelf) {
    return (
      <div className={cn("flex items-center gap-2", className)}>
        {/* Says why there are no buttons, rather than leaving a blank cell that
            reads like a rendering bug. */}
        <Badge tone="info">You</Badge>
      </div>
    );
  }

  const available = actionsFor(account.status);

  /** The action currently in flight, or null. Drives per-button spinners. */
  const inFlight = setStatus.isPending ? setStatus.variables?.action : null;
  const busy = setStatus.isPending || sendPasswordReset.isPending;

  function run(action: AdminAction) {
    setStatus.mutate({ userId: account.id, action });
    setConfirming(null);
  }

  function onActionClick(action: AdminAction) {
    if (ADMIN_ACTION_SPECS[action].destructive) {
      setConfirming(action);
      return;
    }
    run(action);
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {available.map((action) => {
        const spec = ADMIN_ACTION_SPECS[action];
        return (
          <Button
            key={action}
            size="sm"
            variant={spec.destructive ? "destructive" : "outline"}
            loading={inFlight === action}
            disabled={busy && inFlight !== action}
            onClick={() => onActionClick(action)}
            aria-label={actionControlName(action, account.email)}
          >
            {spec.label}
          </Button>
        );
      })}

      <Button
        size="sm"
        variant="ghost"
        loading={sendPasswordReset.isPending}
        disabled={busy && !sendPasswordReset.isPending}
        onClick={() => sendPasswordReset.mutate({ userId: account.id })}
        aria-label={resetControlName(account.email)}
      >
        {RESET_PASSWORD_LABEL}
      </Button>

      {/* Confirmation of a send, in words rather than a toast: there is no toast
          system in this build, and a line that persists until the next action is
          more useful than one that vanishes while you are reading it. The link
          itself is never shown — see `src/lib/supabase/admin.ts`. */}
      {sendPasswordReset.isSuccess && (
        <Text variant="caption" tone="success" role="status">
          Reset email sent
        </Text>
      )}

      {setStatus.isError && (
        <Text variant="caption" tone="destructive" role="alert">
          {setStatus.error.message}
        </Text>
      )}
      {sendPasswordReset.isError && (
        <Text variant="caption" tone="destructive" role="alert">
          {sendPasswordReset.error.message}
        </Text>
      )}

      {confirming && (
        <ConfirmActionDialog
          action={confirming}
          email={account.email}
          pending={setStatus.isPending}
          onConfirm={() => run(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
