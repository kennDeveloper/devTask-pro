import { redirect } from "next/navigation";

import { ADMIN_HOME_PATH } from "@/lib/access/status-route";

/**
 * `/admin` has no screen of its own — it forwards to the one destination the
 * tier has.
 *
 * Without this, an admin who typed the obvious URL would get a 404 from a tier
 * they are actually in, which reads as "this is broken" rather than "you meant
 * the next segment down". `routeForStatus` cannot cover it: `/admin` is inside
 * the admin prefix, so it correctly declines to redirect, and a rule there that
 * special-cased the bare prefix would put a page-existence detail in the pure
 * access module.
 *
 * The role gate still applies — `(admin)/layout.tsx` runs first, so a member
 * asking for `/admin` gets the same 404 as for any other route in the group.
 */
export default function AdminIndexPage() {
  redirect(ADMIN_HOME_PATH);
}
