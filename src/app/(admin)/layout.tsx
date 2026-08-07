import { notFound, redirect } from "next/navigation";

import { AdminShell } from "@/components/admin/admin-shell";
import type { ShellUser } from "@/components/dashboard/types";
import {
  ADMIN_HOME_PATH,
  SIGN_IN_PATH,
  parseAccountRole,
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
 * Chrome and gate for every admin route.
 *
 * ## Two checks, in this order, and the order is the point
 *
 * 1. **Status**, asked of `routeForStatus` — the one place the access rules live
 *    — rather than re-decided here. A signed-out or `pending` caller is
 *    redirected by exactly the rule the proxy would have used.
 *
 * 2. **Role**, and this one answers **404, not a redirect**. Brief criterion 5:
 *    *"a non-admin requesting any /admin/* route gets a 404 or redirect, **not**
 *    a rendered admin page — enforced in the (admin) layout, and independently
 *    at `adminProcedure`."* A 404 is the better of the two options offered,
 *    because a redirect confirms the route exists and that the caller merely
 *    lacks the role. A member should not learn the shape of a tier they are not
 *    in.
 *
 * `routeForStatus` deliberately returns `null` for an active member on
 * `/admin/*` so this layout gets the chance to answer — see the note there.
 * `e2e/auth-flow.spec.ts` has asserted that 404 status code since phase 1, when
 * it was produced by the route simply not existing; it now means something.
 *
 * ## This is the second lock, not the only one
 *
 * `adminProcedure` refuses every admin procedure independently, so a member who
 * somehow rendered this page would still see no data. Neither check is load
 * bearing alone, which is why both exist.
 *
 * ## What this layout must never grow
 *
 * A link to `/today`, `/tasks`, `/overdue` or `/settings`. Criterion 11: no task
 * navigation is reachable or rendered in an admin session, and the whole reason
 * this group has its own shell rather than `DashboardShell` is that the latter's
 * job is exactly those links.
 */
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { user, profile } = await buildContext(supabase);

  const destination = routeForStatus({
    status: parseAccountStatus(profile?.status),
    role: parseAccountRole(profile?.role),
    isSignedIn: Boolean(user),
    // Asked about this group's own home, because every route in it is protected
    // in exactly the way /admin/users is.
    pathname: ADMIN_HOME_PATH,
  });

  if (destination) redirect(destination);
  if (!profile) redirect(SIGN_IN_PATH);

  // The role gate. `notFound()` throws, so nothing below runs for a member and
  // no admin markup is ever produced for them — not even server-side.
  if (profile.role !== "admin") notFound();

  const shellUser: ShellUser = {
    displayName: profileDisplayName(profile.displayName, profile.email),
    email: profile.email,
    roleLabel: accountRoleLabel(profile.role),
    statusLabel: accountStatusLabel(profile.status),
  };

  /**
   * Defined here and handed to the shell, same pattern as `(app)/layout.tsx` and
   * `(gate)/layout.tsx`: sign-out is a Server Action, so the cookie is gone
   * server-side before the redirect renders anything.
   */
  async function signOut() {
    "use server";

    const client = await createClient();
    await client.auth.signOut();
    redirect(SIGN_IN_PATH);
  }

  return (
    <AdminShell user={shellUser} signOut={signOut}>
      {children}
    </AdminShell>
  );
}
