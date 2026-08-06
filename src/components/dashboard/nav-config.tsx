import { AlarmClock, CalendarCheck, ListTodo, Settings } from "lucide-react";

import type { NavGroup, NavItem } from "./types";

/**
 * The real nav for devtask-pro, replacing the template's generated placeholder.
 *
 * Four destinations, two of which do not exist yet. Tasks and Overdue arrive
 * with the task engine in phase 2; until then they are marked `comingSoon` and
 * the Sidebar renders them as inert rows. The alternative — omitting them —
 * would make the app look finished when it is not, and the other alternative —
 * linking them — would hand out two 404s.
 *
 * Consumed only by client components (`Sidebar`), so the lucide icon
 * references never have to cross the server/client boundary.
 */
export const NAV: NavGroup[] = [
  {
    items: [
      { href: "/today", label: "Today", icon: CalendarCheck },
      { href: "/tasks", label: "Tasks", icon: ListTodo, comingSoon: true },
      { href: "/overdue", label: "Overdue", icon: AlarmClock, comingSoon: true },
    ],
  },
  {
    label: "Account",
    items: [{ href: "/settings", label: "Settings", icon: Settings }],
  },
];

/** Where the logo links, and where sign-in lands. Matches `APP_HOME_PATH`. */
export const HOME_HREF = "/today";

/** The pill shown against an unbuilt destination. */
export const COMING_SOON_LABEL = "Soon";

/** Announced to screen readers in place of a link's destination. */
export const COMING_SOON_HINT = "Not built yet — arrives with task tracking";

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
