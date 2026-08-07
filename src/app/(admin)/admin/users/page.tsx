import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AccountList } from "@/components/admin/account-list";
import type { AdminViewer } from "@/components/admin/types";
import { Text } from "@/components/ui/text";
import { SIGN_IN_PATH } from "@/lib/access/status-route";
import { profileDisplayName } from "@/lib/profile-form";
import { createClient } from "@/lib/supabase/server";
import { buildContext } from "@/lib/trpc/server";

export const metadata: Metadata = {
  title: "Accounts",
};

/**
 * The admin tier's one screen: who may use the app.
 *
 * ## Why it is a server component
 *
 * Only to resolve *who is asking*. The list marks the admin's own row and
 * withholds its buttons, and the id for that comes from the session on the
 * server rather than from a client-side lookup mid-render — same reasoning as
 * the task pages' clock, one layer simpler. The guarantee behind it is in
 * `routers/admin.ts`, which refuses a self-targeted action whatever the browser
 * sends.
 *
 * The layout has already established that this caller is an active admin. The
 * redirect below is for the type checker and for the impossible case, not a
 * second gate.
 *
 * ## What this page does not show, and will not
 *
 * Task data of any kind — not a list, not a count, not a chart. The copy says so
 * out loud, because the person most likely to ask for it is the person reading
 * this screen. It is criterion 6 of `docs/gsd/devtask-pro-v1.md` and it is
 * enforced three layers down in the database, not by this file's restraint.
 */
export default async function AdminUsersPage() {
  const supabase = await createClient();
  const { profile } = await buildContext(supabase);

  if (!profile) redirect(SIGN_IN_PATH);

  const viewer: AdminViewer = {
    id: profile.id,
    email: profile.email,
    displayName: profileDisplayName(profile.displayName, profile.email),
  };

  return (
    <div className="mx-auto w-full max-w-6xl space-y-8">
      <header className="space-y-2">
        <Text variant="h1">Accounts</Text>
        <Text variant="body-sm" tone="secondary">
          Approve or reject new signups, suspend and reinstate accounts, and send
          a password-reset email. Accounts waiting on a decision come first.
        </Text>
        <Text variant="body-sm" tone="muted">
          You can see who may use devtask-pro, and nothing about what they use it
          for. Task data is invisible to this tier — including counts — and that
          is enforced by the database rather than by this page.
        </Text>
      </header>

      <AccountList viewer={viewer} />
    </div>
  );
}
