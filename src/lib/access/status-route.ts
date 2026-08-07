/**
 * Where a request belongs, given the caller's account status.
 *
 * This module is deliberately **pure**: no request, no cookies, no database,
 * no Next.js imports. `src/middleware.ts` does the I/O (refresh the session,
 * read `profiles.status`) and then asks this function one question — "given
 * this status on this path, where does the caller go?". That split is what
 * makes the access model exhaustively unit-testable in `status-route.test.ts`
 * without a running stack, and it is the only place the routing rules live.
 *
 * THE REDIRECT LOOP THIS FILE EXISTS TO PREVENT
 * The obvious implementation — "pending? send them to /pending" — sends a
 * pending user to /pending, which is itself a path a pending user is not
 * "active" on, which sends them to /pending, forever. Same for /no-access, and
 * same for a signed-out user on /sign-in. The fix is not clever ordering: it is
 * an explicit, enumerated set of paths that pass through *unconditionally*,
 * checked before any status rule runs. That set is `ALWAYS_ALLOWED_PREFIXES`
 * below, and every one of its members has a loop test named after it.
 *
 * SCOPE, and the one line of it phase 5 changed. This module routes on
 * `profiles.status`, and now also on `profiles.role` — but only to answer *where
 * a caller belongs*, never *whether they may render /admin/\**. Those are two
 * different questions and phase 1 was right to separate them:
 *
 *   - "May this caller render an admin page?" is a SECURITY question, and it is
 *     still answered in `src/app/(admin)/layout.tsx` (which calls `notFound()`)
 *     and independently at `adminProcedure`. A member asking for /admin/users
 *     therefore gets `null` from here — the proxy lets them through so the
 *     layout can 404 them, which is what brief criterion 5 asks for and what
 *     `e2e/auth-flow.spec.ts` has asserted since phase 1. Turning that into a
 *     redirect here would bypass the layout and quietly weaken the guarantee.
 *
 *   - "Where does a caller with no particular destination land?" is a ROUTING
 *     question, and routing lives here. An admin has no task UI (see
 *     ADMIN_HOME_PATH below), so anything outside /admin sends them home.
 */

/** The four values of `profiles.status` — see `supabase/migrations/0001_initial_schema.sql`. */
export type AccountStatus = "pending" | "active" | "rejected" | "suspended";

const ACCOUNT_STATUSES: readonly string[] = [
  "pending",
  "active",
  "rejected",
  "suspended",
];

/** The two values of `profiles.role`. Mirrors the CHECK in 0001. */
export type AccountRole = "member" | "admin";

const ACCOUNT_ROLES: readonly string[] = ["member", "admin"];

/**
 * Narrow an untrusted value to an `AccountRole`.
 *
 * Anything unrecognised — including a failed profile read — becomes `null`,
 * which is treated as `member`. That is the safe direction: the worst outcome is
 * an admin being sent to /today instead of /admin/users, whereas defaulting to
 * `admin` would hand the admin *destination* to an unreadable row. It cannot
 * grant admin *access* either way, because access is the layout's decision and
 * the layout reads the profile itself.
 */
export function parseAccountRole(value: unknown): AccountRole | null {
  return typeof value === "string" && ACCOUNT_ROLES.includes(value)
    ? (value as AccountRole)
    : null;
}

/**
 * Narrow an untrusted value (a column read back as `string`, or nothing at all)
 * to an `AccountStatus`. Anything unrecognised becomes `null`, which
 * `routeForStatus` treats as "not provisioned" and routes to /sign-in — i.e.
 * an unknown status fails closed rather than falling through to the app.
 */
export function parseAccountStatus(value: unknown): AccountStatus | null {
  return typeof value === "string" && ACCOUNT_STATUSES.includes(value)
    ? (value as AccountStatus)
    : null;
}

/** Where a caller with no usable session goes. */
export const SIGN_IN_PATH = "/sign-in";
/** Where `pending` goes. */
export const PENDING_PATH = "/pending";
/** Where `rejected` and `suspended` both go — one screen, no explanation of which. */
export const NO_ACCESS_PATH = "/no-access";
/** Where an already-signed-in `active` **member** gets sent off the sign-in/up pages. */
export const APP_HOME_PATH = "/today";

/**
 * Where an active **admin** lands, and the only part of the app they have.
 *
 * The two tiers are disjoint in the UI, decided in `docs/gsd/phase-5-plan.md`.
 * Brief criterion 11 requires that no Today/Tasks/Overdue destination is
 * reachable or rendered in an admin session, and `(app)/layout.tsx` renders
 * `DashboardShell`, whose whole job is linking to those three routes — so an
 * admin on /settings would be looking at task navigation. Rather than branch on
 * role inside the member shell, the whole (app) group sends an admin here.
 *
 * The consequence is deliberate and worth saying out loud: **an admin has no
 * task UI at all.** Their rows would still be RLS-scoped to them if any existed;
 * there is simply no screen. Somebody who wants both keeps two accounts.
 */
export const ADMIN_HOME_PATH = "/admin/users";

/**
 * The admin tier's route prefix.
 *
 * The rule below is written as an inversion around this — "an admin's home is
 * /admin; everything else in the app is not theirs" — rather than as a list of
 * (app) routes to redirect. A list would need extending every time a phase adds
 * a route, and the failure mode of forgetting is a task screen quietly becoming
 * reachable in an admin session, which is exactly criterion 11.
 */
export const ADMIN_PREFIX = "/admin";

/**
 * Paths that pass through no matter who is asking. Matched on segment
 * boundaries, so `/sign-in` covers `/sign-in` and `/sign-in/anything` but not
 * `/sign-inbox`.
 *
 * Every entry is here for a stated reason. Adding one without a reason is how
 * a gate quietly stops being a gate.
 */
export const ALWAYS_ALLOWED_PREFIXES: readonly string[] = [
  // (auth) route group. Gating these would make it impossible to sign in at
  // all: the signed-out caller is bounced to /sign-in, which is protected,
  // which bounces them to /sign-in...
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  // /reset-password is reached *while signed in* — the recovery link
  // establishes a session and then lands here. It must stay reachable for a
  // user of any status, including a suspended one changing a compromised
  // password.
  "/reset-password",

  // (gate) route group — the screens this module redirects to. The loop
  // breaker proper.
  "/pending",
  "/no-access",

  // The PKCE / email-confirmation exchange. Redirecting it strands the user
  // holding a one-time code they can never spend, and the code expires.
  "/auth",

  // Route handlers carry their own authorization: tRPC enforces status through
  // its `activeProcedure` tier (which re-reads the profile), and the cron
  // endpoint authenticates with a shared secret. Redirecting an API call would
  // answer a JSON client with an HTML page — a confusing parse error instead of
  // an honest 401/403.
  "/api",

  // Next.js internals: RSC payloads, chunks, the image optimiser. Blocking
  // these breaks the very screens we are redirecting people to.
  "/_next",
];

/**
 * The two pages an already-signed-in active user has no business sitting on.
 * Deliberately NOT /forgot-password or /reset-password — bouncing those would
 * break password recovery, which by design runs inside a fresh session.
 */
const ENTRY_AUTH_PREFIXES: readonly string[] = ["/sign-in", "/sign-up"];

/** Strip a trailing slash so `/pending/` and `/pending` are one path. */
function normalise(pathname: string): string {
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const trimmed = withLeadingSlash.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** Segment-boundary prefix match: `/auth` matches `/auth/callback`, not `/authorise`. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * A request for a file rather than a route — `/robots.txt`, `/site.webmanifest`,
 * `/fonts/inter.woff2`. The middleware matcher already drops `_next/static` and
 * image extensions, but anything else served out of `public/` still reaches us,
 * and redirecting a font or stylesheet visibly breaks the page it belongs to.
 *
 * The cost of the heuristic is that a route whose final segment contains a dot
 * would be treated as an asset. devtask-pro has none (ids are uuids).
 */
function looksLikeAsset(pathname: string): boolean {
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[a-zA-Z0-9]{1,8}$/.test(lastSegment);
}

/**
 * True when the path is reachable regardless of who (or whether anyone) is
 * signed in. Exported so tests — and any future guard — can assert against the
 * same predicate the middleware uses rather than a copy of it.
 */
export function isAlwaysAllowed(pathname: string): boolean {
  const path = normalise(pathname);

  // The marketing landing page. Public by definition; a signed-out visitor
  // seeing /sign-in instead of the product is a broken front door.
  if (path === "/") return true;

  if (looksLikeAsset(path)) return true;

  return ALWAYS_ALLOWED_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

export interface RouteForStatusInput {
  /** `profiles.status`, or `null` for "signed in but no profile row was readable". */
  status: AccountStatus | null;
  /**
   * `profiles.role`, or `null`/absent for "not read, or not readable" — both of
   * which are treated as `member`. Optional so every existing caller that only
   * cares about status keeps working unchanged.
   */
  role?: AccountRole | null;
  /** Whether `supabase.auth.getUser()` returned a user. */
  isSignedIn: boolean;
  /** `request.nextUrl.pathname` — no query string, no origin. */
  pathname: string;
}

/**
 * Where an active caller of this role belongs when they have no destination of
 * their own — off the sign-in form, or off a tier that is not theirs.
 */
function homeFor(role: AccountRole | null | undefined): string {
  return role === "admin" ? ADMIN_HOME_PATH : APP_HOME_PATH;
}

/**
 * The whole access model, as one pure function.
 *
 * @returns a path to redirect to, or `null` to let the request through.
 */
export function routeForStatus({
  status,
  role,
  isSignedIn,
  pathname,
}: RouteForStatusInput): string | null {
  const path = normalise(pathname);

  // 1. An approved user has no reason to be looking at the sign-in form. This
  //    runs BEFORE the always-allowed check, because /sign-in is in that set
  //    and would otherwise pass straight through. Which home they get depends
  //    on their tier — an admin sent to /today would be bounced again by rule 4.
  if (
    isSignedIn &&
    status === "active" &&
    ENTRY_AUTH_PREFIXES.some((prefix) => matchesPrefix(path, prefix))
  ) {
    return homeFor(role);
  }

  // 2. The loop breaker. Auth pages, gate screens, the callback, API routes and
  //    assets are reachable by everyone, so no status can bounce a caller onto
  //    a path that bounces them back.
  if (isAlwaysAllowed(path)) return null;

  // 3. Past this point the path is protected: it needs a session.
  if (!isSignedIn) return SIGN_IN_PATH;

  // 4. Signed in — the status decides the screen. Read fresh from the database
  //    on every request (see src/middleware.ts) so a suspension applied a
  //    second ago is honoured on the next navigation, rather than waiting out
  //    an access token that stays valid for up to an hour.
  switch (status) {
    case "active":
      // The tiers are disjoint. An admin outside /admin is standing in the
      // member app, which they do not have — send them home. A member on
      // /admin/* deliberately falls through to `null`: the proxy lets them
      // reach the route so the (admin) layout can answer with a 404 rather
      // than a redirect, which is what criterion 5 asks for and what the
      // phase-1 e2e asserts. Role decides destinations here, never access.
      if (role === "admin" && !matchesPrefix(path, ADMIN_PREFIX)) {
        return ADMIN_HOME_PATH;
      }
      return null;
    case "pending":
      return PENDING_PATH;
    case "rejected":
    case "suspended":
      // One screen for both. The user is not told which, and is not told why.
      return NO_ACCESS_PATH;
    case null:
      // Signed in with no readable profile row. The 0002 trigger creates one on
      // `auth.users` insert, so this means either a failed read or a genuinely
      // unprovisioned account. Either way: no profile, no access.
      return SIGN_IN_PATH;
  }

  // Unreachable while `status` is typed. A future AccountStatus value that
  // nobody routed lands here and is refused, rather than being let through.
  return SIGN_IN_PATH;
}
