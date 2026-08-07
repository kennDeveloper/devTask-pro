"use client";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Text } from "@/components/ui/text";
import { ADMIN_ACTION_SPECS, type AdminAction } from "@/lib/admin/transitions";

/**
 * The confirm step in front of a destructive account action (criterion 13).
 *
 * Reject and suspend both end somebody's session. Approving in error is undone
 * by suspending; suspending in error has already thrown a person out of the app
 * mid-sentence. So the two that take access away ask first, and the two that
 * grant it do not — a confirm on every button is a confirm nobody reads.
 *
 * Which actions get one is not decided here: it is `spec.destructive` in
 * `src/lib/admin/transitions.ts`, so the rule and the copy travel together and
 * `<AccountActions>` never has to know which is which.
 *
 * The dialog is the native `<dialog>` wrapper from phase 2, so focus trapping,
 * Escape and the top layer come from the browser rather than from us.
 */

export interface ConfirmActionDialogProps {
  action: AdminAction;
  /** Named in the body, so the admin can see which row they are about to change. */
  email: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmActionDialog({
  action,
  email,
  pending,
  onConfirm,
  onCancel,
}: ConfirmActionDialogProps) {
  const spec = ADMIN_ACTION_SPECS[action];

  return (
    <Dialog
      open
      onClose={onCancel}
      title={spec.confirmTitle}
      description={spec.confirmBody}
      footer={
        <>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          {/* The confirming button repeats the verb rather than saying "OK".
              A dialog whose buttons are Cancel and OK makes the reader
              reconstruct what OK meant from the title they have already
              scrolled past. */}
          <Button
            variant="destructive"
            loading={pending}
            onClick={onConfirm}
            aria-label={`Confirm: ${spec.label} ${email}`}
          >
            {spec.label}
          </Button>
        </>
      }
    >
      <Text variant="body-sm" tone="secondary">
        This affects <span className="font-medium text-ink">{email}</span>.
      </Text>
    </Dialog>
  );
}
