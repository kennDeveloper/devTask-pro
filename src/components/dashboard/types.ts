import type { LucideIcon } from "lucide-react";

/**
 * One destination in the sidebar.
 *
 * `comingSoon` exists because this build ships a nav that is honest about
 * what is not built yet. Such an item renders as a visibly inert row — never
 * as a link to a route that would 404 — so someone opening the app can see
 * where it is going without walking into a wall.
 */
export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  comingSoon?: boolean;
};

export type NavGroup = {
  label?: string;
  items: NavItem[];
};

/**
 * The identity the shell chrome shows.
 *
 * The kickoff template's equivalent carried an `orgName`. devtask-pro has no
 * organisations: every row belongs to exactly one person and RLS scopes on
 * `auth.uid()`, so there is no tenant to name. Keeping the field would have
 * invented a second access axis in the UI that the database does not have.
 */
export type ShellUser = {
  displayName: string;
  email: string;
  roleLabel: string;
  statusLabel: string;
};
