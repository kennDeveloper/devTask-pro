/**
 * The admin tier's state machine, as pure values.
 *
 * An admin governs **access and nothing else**. The four actions below are the
 * whole of that power, and this file is the single place the rules about them
 * live — which of them a given account is eligible for, what status each one
 * produces, and which need confirming before they fire. The tRPC router, the
 * Zod schema and the row/card UI all read this table rather than each spelling
 * out their own copy of "you cannot suspend somebody who was never approved".
 *
 * Nothing here imports React or a database connection. This is the product rule;
 * `src/components/admin/account-presentation.ts` owns how it is spelled on a
 * screen, and `src/lib/db/repos/profiles.ts` owns how it is written down.
 *
 * ---------------------------------------------------------------------------
 * WHY `rejected` AND `suspended` BOTH EXIST WHEN BOTH LAND ON /no-access
 * ---------------------------------------------------------------------------
 * Because they differ in **provenance**, which is what the admin needs to know
 * when the row comes back around months later:
 *
 *   rejected   — a signup that was never let in. `approved_at` is still null.
 *   suspended  — an account that WAS let in, and has been switched back off.
 *
 * The user is told neither (one screen, no explanation — see
 * `status-route.ts`). The admin is told both, because "has this person ever had
 * access?" changes what reinstating them means.
 *
 * Both are reversible. The realistic failure here is a mis-click on the wrong
 * row in a list of near-identical email addresses, and "sorry, that account is
 * permanently dead" would be a worse product than a switch that goes both ways.
 * What is *not* offered is Reject on an account that is already active: to
 * remove somebody who is in, you suspend them, and the two words keep meaning
 * different things.
 */

import type { ProfileStatus } from "@/lib/db/schema";

/** The four things an admin can do to somebody else's account. */
export const ADMIN_ACTIONS = [
  "approve",
  "reject",
  "suspend",
  "reinstate",
] as const;

export type AdminAction = (typeof ADMIN_ACTIONS)[number];

export interface AdminActionSpec {
  /** The button's word. Imperative — it is a thing you are about to do. */
  label: string;
  /** The status the account holds afterwards. */
  result: ProfileStatus;
  /** The statuses this action is offered on. Anything else is refused. */
  from: readonly ProfileStatus[];
  /**
   * Whether this action bans the account in Supabase Auth as well as moving the
   * status column. `false` means the opposite — *lift* any ban — so the auth
   * state after an action is a pure function of the action rather than of the
   * order the actions happened to arrive in.
   *
   * ## Only `suspend` bans, and that is a decision rather than an oversight
   *
   * `docs/gsd/devtask-pro-v1.md`: *"Suspension **additionally** bans in Supabase
   * so live sessions die at once; a status flag alone would leave an active JWT
   * working until expiry."* It says suspension, and only suspension.
   *
   * Extending the ban to `reject` looks like symmetry and is a bug. Measured
   * against the local stack: **a banned account cannot sign in at all** —
   * `signInWithPassword` returns `user_banned`. Criterion 2 says a rejected user
   * *sees* `/no-access`, and nobody can see a screen they cannot authenticate
   * far enough to reach. Banning them would replace an honest "this account
   * cannot be used" page with a generic sign-in failure, which is the opposite
   * of what the (gate) route group was built for.
   *
   * A rejected user is still shut out of everything: the proxy reads
   * `profiles.status` live on every request and `activeProcedure` re-checks it,
   * so the token they hold buys them nothing. What the ban adds for suspension
   * is that the session cannot outlive its current access token — measured, the
   * refresh grant returns `400 user_banned` while `GET /auth/v1/user` still
   * returns 200, which is precisely why the proxy's live read is what lands them
   * on /no-access rather than the ban doing it.
   */
  bans: boolean;
  /**
   * Whether the UI must confirm before firing (brief criterion 13).
   *
   * True for the two that take access away. Approving in error is undone by
   * suspending; suspending in error has already ended somebody's session.
   */
  destructive: boolean;
  /** What the confirm dialog says, when there is one. */
  confirmTitle: string;
  confirmBody: string;
}

/**
 * The transition table.
 *
 *   from        Approve        Reject          Suspend         Reinstate
 *   pending     -> active      -> rejected     —               —
 *   active      —              —               -> suspended    —
 *   rejected    -> active      —               —               —
 *   suspended   —              —               —               -> active
 *
 * Approve appears twice on purpose: from `pending` it is the signup decision,
 * and from `rejected` it is that decision being taken back. It stamps
 * `approved_at` only the first time — see `setAccountStatusAsAdmin`.
 */
export const ADMIN_ACTION_SPECS: Record<AdminAction, AdminActionSpec> = {
  approve: {
    label: "Approve",
    result: "active",
    from: ["pending", "rejected"],
    bans: false,
    destructive: false,
    confirmTitle: "",
    confirmBody: "",
  },
  reject: {
    label: "Reject",
    result: "rejected",
    // Deliberately not banned — see the long note on `bans` above. A rejected
    // user must stay able to sign in far enough to be told why they cannot.
    bans: false,
    from: ["pending"],
    destructive: true,
    confirmTitle: "Reject this signup?",
    confirmBody:
      "They will not be able to use the app, and will be told so the next time they sign in. You can approve them later if this was a mistake.",
  },
  suspend: {
    label: "Suspend",
    result: "suspended",
    from: ["active"],
    bans: true,
    destructive: true,
    confirmTitle: "Suspend this account?",
    confirmBody:
      "They are signed out of the app immediately, including any session open right now. Their tasks are untouched and come back with them if you reinstate.",
  },
  reinstate: {
    label: "Reinstate",
    result: "active",
    from: ["suspended"],
    bans: false,
    destructive: false,
    confirmTitle: "",
    confirmBody: "",
  },
};

/** The messages the router and the UI both quote, so an error reads the same in both. */
export const ADMIN_ACTION_MESSAGES = {
  illegalTransition: "That action is not available for this account.",
  self: "You cannot change your own account here.",
  lastAdmin: "This is the last active administrator — approve another one first.",
  notFound: "That account no longer exists.",
} as const;

/** True for a value the router's Zod schema will accept as an action. */
export function isAdminAction(value: unknown): value is AdminAction {
  return (
    typeof value === "string" &&
    (ADMIN_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * The actions offered on an account in this status, in the order they are shown.
 *
 * Built by filtering the table rather than by a second `switch`, so the two can
 * never disagree about whether Suspend belongs on a `pending` row.
 */
export function actionsFor(status: ProfileStatus): AdminAction[] {
  return ADMIN_ACTIONS.filter((action) =>
    ADMIN_ACTION_SPECS[action].from.includes(status),
  );
}

/** Whether this action is legal from this status. */
export function canApply(action: AdminAction, status: ProfileStatus): boolean {
  return ADMIN_ACTION_SPECS[action].from.includes(status);
}

/** The status the account ends up in. Ask `canApply` first. */
export function resultOf(action: AdminAction): ProfileStatus {
  return ADMIN_ACTION_SPECS[action].result;
}

/**
 * Whether approving should stamp `approved_at` / `approved_by`.
 *
 * Only the first approval is an event worth recording. Approving a previously
 * rejected account is still the moment they were let in, so it stamps too — but
 * `setAccountStatusAsAdmin` will not overwrite a stamp that is already there,
 * because reinstating somebody must not rewrite when they originally joined.
 */
export function stampsApproval(action: AdminAction): boolean {
  return resultOf(action) === "active";
}
