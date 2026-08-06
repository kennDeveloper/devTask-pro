import { AlarmClock, CalendarCheck, ListTodo, Settings } from "lucide-react";

import type { NavGroup, NavItem } from "./types";

/**
 * The real nav for devtask-pro, replacing the template's generated placeholder.
 *
 * Four destinations, and as of phase 2 all four are real routes. Tasks and
 * Overdue carried `comingSoon: true` through phase 1 — visible so the app did
 * not look finished when it was not, inert so the nav did not hand out two
 * 404s. `src/app/(app)/tasks` and `src/app/(app)/overdue` now exist, so the
 * flag comes off and they are ordinary links. Removing it is not cosmetic: an
 * item flagged `comingSoon` is never reported active (see `isNavItemActive`),
 * so leaving it on would have left both rows unhighlighted while you stood on
 * them.
 *
 * Consumed only by client components (`Sidebar`), so the lucide icon
 * references never have to cross the server/client boundary.
 */
export const NAV: NavGroup[] = [
  {
    items: [
      { href: "/today", label: "Today", icon: CalendarCheck },
      { href: "/tasks", label: "Tasks", icon: ListTodo },
      { href: "/overdue", label: "Overdue", icon: AlarmClock },
    ],
  },
  {
    label: "Account",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

/** Where the logo links, and where sign-in lands. Matches `APP_HOME_PATH`. */
export const HOME_HREF = "/today";

/**
 * The pill and the hint shown against an unbuilt destination.
 *
 * **Nothing in `NAV` currently uses them.** They stay — along with the
 * `comingSoon` flag, `UnbuiltNavRow` and the guard in `isNavItemActive` —
 * because the mechanism is not about tasks; it is how this nav is honest about
 * any destination that is on the roadmap but not on disk, and phase 5's admin
 * tier will want it again. Deleting and re-adding it would be churn on a rule
 * that costs one line to keep.
 *
 * The wording is therefore phase-agnostic. It used to read "arrives with task
 * tracking", which stopped being true the moment /tasks and /overdue shipped
 * and would have been a lie waiting for the next reader.
 */
export const COMING_SOON_LABEL = "Soon";

/** Announced to screen readers in place of a link's destination. */
export const COMING_SOON_HINT = "Not built yet — arrives in a later release";

/**
 * Whether a nav item represents the page currently on screen.
 *
 * A `comingSoon` item is never active: it has no route, so nothing can be on
 * it. Kept out of the component so the rule can be read (and tested) in one
 * place rather than inferred from a ternary inside JSX.
 */
export function isNavItemActive(
  pathname: string | null | undefined,
  item: NavItem,
): boolean {
  if (item.comingSoon || !pathname) return false;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
