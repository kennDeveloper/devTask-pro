import { Users } from "lucide-react";

import type { NavItem } from "@/components/dashboard/types";

/**
 * The admin tier's destinations.
 *
 * One entry today. It is a list rather than a hard-coded link so a second admin
 * screen is a one-line change — and so the shape of this file matches
 * `components/dashboard/nav-config.tsx` for the next reader.
 *
 * **`components/dashboard/nav-config.tsx` is deliberately not touched.** Its own
 * comment anticipated that "phase 5's admin tier will want" the `comingSoon`
 * mechanism, but that turned out to be the wrong shape: the two tiers are
 * disjoint (see `ADMIN_HOME_PATH` in `src/lib/access/status-route.ts`), so an
 * admin entry in the *member* nav would be a link no member may follow, and a
 * task entry here would be a route no admin may reach. What is reused is the
 * `NavItem` type and `isNavItemActive()` — imported, not edited — which also
 * means this phase adds no merge conflict to a file phase 3 is editing.
 */
export const ADMIN_NAV: NavItem[] = [
  { href: "/admin/users", label: "Users", icon: Users },
];

/** Where the admin logo links. Matches `ADMIN_HOME_PATH`. */
export const ADMIN_HOME_HREF = "/admin/users";
