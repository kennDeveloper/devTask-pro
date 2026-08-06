import { redirect } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/DashboardShell";
import type { ShellUser } from "@/components/dashboard/types";
import {
  APP_HOME_PATH,
  SIGN_IN_PATH,
  parseAccountStatus,
  routeForStatus,
} from "@/lib/access/status-route";
import {
  accountRoleLabel,
  accountStatusLabel,
  profileDisplayName,
} from "@/lib/profile-form";
import { createClient } from "@/lib/supabase/server";
import { buildContext } from "@/lib/trpc/server";

/**
 * Chrome for every signed-in application route.
 *
 * `src/middleware.ts` is the gate; this is the second lock on the same door.
 * It asks `routeForStatus` — the one place the access rules live — rather than
 * re-deciding them, passing `APP_HOME_PATH` because every route in this group
 * is protected in exactly the way /today is. So a `pending` user who somehow
 * reached here is sent to /pending by the same rule the middleware would have
 * used, and the chrome never renders for an account that is not active.
 *
 * The profile comes from `buildContext`, which reads it through `withUser()`.
 * That is the house rule (`src/lib/db/client.ts`): user-facing reads go
 * through the RLS-scoped path, so the row rendered in the sidebar is one the
 * database has confirmed belongs to the caller.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { user, profile } = await buildContext(supabase);

  const destination = routeForStatus({
    status: parseAccountStatus(profile?.status),
    isSignedIn: Boolean(user),
    pathname: APP_HOME_PATH,
  });

  if (destination || !profile) {
    redirect(destination ?? SIGN_IN_PATH);
  }

  const shellUser: ShellUser = {
    displayName: profileDisplayName(profile.displayName, profile.email),
    email: profile.email,
    roleLabel: accountRoleLabel(profile.role),
    statusLabel: accountStatusLabel(profile.status),
  };

  /**
   * Defined once here and handed to the shell, which puts it on a context so
   * the sidebar and the settings screen share one implementation. Same pattern
   * as `(gate)/layout.tsx`: sign-out is a Server Action, so the cookie is gone
   * server-side before the redirect renders anything.
   */
  async function signOut() {
    "use server";

    const client = await createClient();
    await client.auth.signOut();
    redirect(SIGN_IN_PATH);
  }

  return (
    <DashboardShell user={shellUser} signOut={signOut}>
      {children}
    </DashboardShell>
  );
}
