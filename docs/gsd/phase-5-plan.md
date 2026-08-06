# devtask-pro phase 5 — plan

> GSD stage 2 of 5 · [Discuss ✓] → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/phase-5-discuss.md` · Branch: `phase-5-admin`
> Phase 5 of 6: **admin tier** · Built in a worktree beside phase 3; see "Parallel build" in the brief.

## Goal

An admin signs in, lands on `/admin/users`, and governs **access and nothing else**: approve or
reject a signup, suspend or reinstate an account, trigger a password-reset email. They see email,
display name, signup date, status and last sign-in — and **no task data of any kind, not even a
count**. Every phase-1 gate that was previously exercised by hand-editing a row is now driven
through the UI, and criterion 6 stays proven: an admin's own session reading `task_occurrence`
returns zero rows.

## Research findings (verified in the code and against the running stack, not assumed)

Findings 1–5 come from a probe run against this worktree's stack (`.verify/probe-ban.ts`, gitignored)
because each one decides a design question that guesswork would have got wrong.

1. **A Supabase Auth ban does NOT invalidate an already-issued access token.** Measured:
   after `updateUserById(uid, { ban_duration: "876000h" })`, `GET /auth/v1/user` with the live
   token still returns **200**. This is the single most load-bearing fact in the phase. It means the
   proxy's `getUser()` still resolves for a just-suspended user, the live `profiles.status` read
   still runs, and they land on **`/no-access`** — criterion 3, and the phase-1 e2e that already
   asserts it, both survive the ban being added. Had `/user` 403'd, a suspended user would have been
   bounced to `/sign-in` and criterion 3 would have silently changed meaning.
2. **The ban does kill the refresh grant.** `POST /auth/v1/token?grant_type=refresh_token` →
   `400 {"error_code":"user_banned"}`. So the session dies for good at most one access-token lifetime
   later, and immediately for anything that goes through the proxy or `activeProcedure`. That is
   exactly the "live sessions die at once" the v1 brief bought the ban for.
3. **`ban_duration: "none"` fully lifts it** — `banned_until` returns to unset and the refresh grant
   returns 200. Reinstate is a real inverse, not an approximation.
4. **`dbAdmin` (the `postgres` role) can read `auth.users`.** `select id, email, last_sign_in_at,
   banned_until from auth.users` succeeds. So `last_sign_in_at` needs no column, no trigger and no
   migration — it is joined at read time in the admin repo.
5. **`authenticated` cannot read `auth.users`** — `permission denied for table users`. The column
   the admin list shows is already unreachable by every other tier, with no policy for us to write.
6. **No migration is required, and `0006` stays unused.** `profiles` already carries `role`,
   `status`, `approved_at` and `approved_by` (0001); `profiles_status_idx` already indexes the one
   query that reads across profiles; `guard_profile_privileged_columns()` (0003) already lets a
   `dbAdmin` write through because such a connection has no JWT `sub`, and already blocks the
   account holder. There is no new table, no new column, no new grant and no new policy. Adding a
   migration to "own" the phase would be ceremony.
7. **`adminProcedure` is already built and already composed correctly** (`src/lib/trpc/server.ts:207`):
   `activeProcedure.use(isAdmin)`, so a *suspended* admin is rejected before the role is looked at.
   Its doc comment already states the rule this phase must not break — "`admin` governs which
   operations exist, never which rows are readable".
8. **`routeForStatus()` is status-only today and says so in writing** (`status-route.ts:19-22`):
   *"`profiles.role` … is a phase-5 concern enforced in the (admin) layout and the tRPC
   `adminProcedure`, not here."* That sentence is about **keeping non-admins out of `/admin/*`**, and
   it stands — see the decisions below. It is not about where an admin *lands*, which is a routing
   question and does belong here.
9. **`status-route.test.ts:323` already pins the member case**: an `active` caller on `/admin/users`
   gets `null` from `routeForStatus`, i.e. the proxy lets them reach the route so the layout can 404
   them. `e2e/auth-flow.spec.ts:94` asserts that 404 through the browser. Both must keep passing —
   which rules out "redirect members away from `/admin`" as an implementation of criterion 5.
10. **`profiles.ts` (the repo) was written anticipating this phase**: *"admin account operations
    belong to the phase 5 admin tier and will need their own clearly-named entry points, precisely so
    that 'read my profile' and 'change somebody else's status' never share a function."*
11. **The e2e naming rule has a structural fix available.** `AGENTS.md` warns that `task-row.tsx` and
    `task-card.tsx` "must stay in step; renaming in one is a silent e2e break in the other" — because
    each spells its own `aria-label`. The admin list can make that impossible instead of merely
    forbidden, by putting the action buttons in **one** component both presentations render.
12. **`e2e/helpers/accounts.ts` already creates an admin**: `createAccount(email, "active", "admin")`.
    Its header comment says it "stands in for the admin tier, which does not exist until phase 5" —
    it stays, because a spec still needs *an* admin to exist before it can drive the UI.
13. **`MAILPIT_URL` defaults to `:54424`** (`e2e/helpers/mailpit.ts:9`), which is *main's* stack. This
    worktree's Mailpit is `:54444`. Fixed in the gitignored `.env.local`, which `playwright.config.ts`
    loads — no committed change, because on `main` the default is correct.
14. **UI primitives present and sufficient**: Badge (with `danger`/`warning`/`success`/`info` tones),
    Button (with `loading`), Card, Dialog (native `<dialog>`, phase 2), Skeleton, Table, Text. Nothing
    new is needed. No Radix.

## Decisions taken at plan time

### The four open items from the brief

**1 · Where does an admin land after sign-in? → `/admin/users`, decided by `routeForStatus()`, which
grows an optional `role` dimension.**

Two different questions were hiding in one, and they get different homes:

- *"May this caller render `/admin/*`?"* — **security**. Stays exactly where phase 1 put it: the
  `(admin)` layout calls `notFound()`, and `adminProcedure` refuses independently. A 404 rather than
  a redirect, so the route's existence is not confirmed to a member (criterion 5, finding 9).
- *"Where does a caller with no specific destination belong?"* — **routing**. That is what
  `routeForStatus()` is, and `AGENTS.md` is explicit that new rules go there and not in the proxy.

So `routeForStatus` takes `role?: "member" | "admin"` and, for an **active admin**, redirects any
path that is neither always-allowed nor under `/admin` to `ADMIN_HOME_PATH = "/admin/users"`. The
rule is written as an inversion — *"an admin's home is `/admin`; everything else in the app is not
theirs"* — rather than as a list of `(app)` routes, so a route added in phase 4 or 6 cannot quietly
become reachable by an admin because someone forgot to extend an array.

The proxy pays nothing for this: it already reads the profile row, so `select("status")` becomes
`select("status, role")` — one column, same round trip.

**2 · Can an admin also be an ordinary user? → No. The tiers are disjoint in the UI.**

Criterion 11 requires that no Today/Tasks/Overdue destination is *reachable or rendered* in an admin
session, and `(app)/layout.tsx` renders `DashboardShell`, whose entire job is linking to those three
routes. An admin visiting `/settings` would therefore be looking at task navigation. Half-measures
(hide the nav for admins) would put a role branch inside the member shell, which is the opposite of
the separation this phase is meant to make visible. So the whole `(app)` group redirects to
`/admin/users` for an admin, and the admin shell offers sign-out and the theme toggle itself.

The consequence, stated so nobody has to discover it: **an admin has no task UI at all.** Their rows
would still be RLS-scoped to them if any existed; there is simply no screen. Somebody who wants both
keeps two accounts. The role column stays single, as designed.

**3 · Reject vs suspend → both reversible, but they are different decisions and the transition table
says so.**

| from | Approve | Reject | Suspend | Reinstate |
|---|---|---|---|---|
| `pending` | → `active` | → `rejected` | — | — |
| `active` | — | — | → `suspended` | — |
| `rejected` | → `active` | — | — | — |
| `suspended` | — | — | — | → `active` |

They earn their places because they differ in **provenance**, which is what the admin needs to know
when the row comes back around: `rejected` was never let in (`approved_at` stays null until an
approve), `suspended` was let in and switched off. Reject is offered only on a signup awaiting a
decision — to remove somebody who is already in, you suspend. Both are undoable, because the
realistic failure is a mis-click on the wrong row, and "sorry, that account is permanently dead"
would be a worse product than a reversible switch.

The table lives in a pure module (`src/lib/admin/transitions.ts`) and is unit-tested, so the UI, the
Zod schema and the server guard all read the same one.

**4 · Password reset → `resetPasswordForEmail`, not the admin `generateLink` API.**

`generateLink` returns a credential-bearing recovery URL **to the admin's browser**. An admin who
can mint a link that signs them in as any member is an admin who can read that member's tasks — and
they would do it through an ordinary member session, which RLS would happily serve because it is
that member's session. That is not a hole RLS can close; it is an account takeover with a UI.
`resetPasswordForEmail` sends the link to the account holder's own inbox, needs no privileged data
path, reuses the redirect (`authCallbackUrl("/reset-password")`) the `/forgot-password` page already
uses, and is exercised by GoTrue's ordinary rate limiting.

The admin is told "sent", never shown a link.

### The rest

- **`dbAdmin` admin functions live in `src/lib/db/repos/profiles.ts`, not a new module.** `AGENTS.md`
  mandates one repo module per *table*, and splitting by privilege would leave two modules writing
  `profiles` and needing to agree about its triggers. The brief itself says "the admin-scoped
  functions on the `profiles` repo". Each is suffixed **`AsAdmin`**, so the escalation is legible at
  the call site and greppable in review, and they sit under a banner comment stating the one rule:
  *these functions may name `profiles` and `auth.users` and nothing else.*
- **One `admin.setStatus` mutation with an `action` enum, not four procedures.** The four actions are
  one state machine; four procedures would be four copies of the same three guards (not yourself,
  legal transition, not the last admin). Per-button loading still works — each row owns its own
  `useMutation`, and `isPending && variables.action === "suspend"` is that button's state.
  `admin.sendPasswordReset` is separate because it changes no status and touches no row.
- **The last-active-admin guard runs inside the same transaction as the write.** A bare
  count-then-update is a real race: two admins suspending each other simultaneously both see a count
  of 2 and both proceed, leaving zero. The repo takes `select id from profiles where role='admin' and
  status='active' for update` inside the transaction, so the second one blocks and then sees the
  truth. This is the only way the criterion-10 guard is worth writing at all.
- **No admin procedure may target the caller's own account.** Simpler and stricter than "may not
  change their own role or status": one sentence, one test, and it matches what
  `guard_profile_privileged_columns()` already says in the database — *"Admins administer other
  people. Nobody edits their own gate."* The admin still appears in the list, marked, with no
  actions.
- **The admin shell is a topbar, no sidebar.** "Deliberately sparse" is the decision from the brief;
  with one destination a 240px rail of one link would be ceremony, and the shape difference is what
  makes an admin session *look* like a different tier at a glance. `ADMIN_NAV` is a list so a second
  destination is a one-line change, and it reuses `NavItem` / `isNavItemActive` from
  `components/dashboard/` **without editing them** — so `nav-config.tsx` is not touched at all and
  phase 3 has one less merge point than the brief anticipated.
- **Row and card share one `<AccountActions>` component.** `AGENTS.md` requires their control names
  to match and warns that keeping them in step is manual. Rendering the same component in both makes
  drift impossible rather than forbidden (finding 11). One `aria-label` template,
  `` `${action.label} ${email}` ``, defined once.
- **Ban on reject as well as suspend; unban on approve and reinstate.** A rejected account is at
  least as unwelcome as a suspended one and can equally be holding a live token from confirming its
  email. Symmetry also means the two "let them in" actions share one code path.
- **The list is ordered pending-first, then newest-first.** The admin's job is the queue; a decision
  awaiting them should not be on page two. Capped at 500 rows with a comment — pagination is out of
  scope, but an uncapped `select *` across a growing table is not a thing to leave for later.

## Tasks

Each is sized for one fresh context window. `[seq]` must follow its predecessor; tasks sharing a wave
touch disjoint files and are parallel-safe.

### Wave 0

**1 · The role dimension in `routeForStatus()`** `[seq]` — *highest blast radius in the phase*
- **Files:** `src/lib/access/status-route.ts`, `src/lib/access/status-route.test.ts`, `src/proxy.ts`
- **Pattern:** the file's own shape — enumerated constants at the top, one pure function, every rule
  with a stated reason.
- **Build:** `AccountRole`, `parseAccountRole()`, `ADMIN_HOME_PATH = "/admin/users"`,
  `ADMIN_PREFIX = "/admin"`, and an optional `role` on `RouteForStatusInput`. In the `active` branch:
  an admin outside `/admin` goes to `ADMIN_HOME_PATH`; everyone else continues to get `null`. In the
  entry-auth branch: an active admin on `/sign-in` or `/sign-up` goes to `ADMIN_HOME_PATH`. The proxy
  selects `status, role` and passes both.
- **Critical:** a member on `/admin/users` must still get `null` (finding 9) or the layout's 404 —
  and the phase-1 e2e asserting it — is bypassed.
- **Output:** one place that decides where anybody lands, still pure and still request-free.
- **Check:** the matrix test gains an `admin` caller and an `/admin` path group, with every
  caller × group cell filled in; the **fixed-point property test** covers the new cells (admin on
  `/today` → `/admin/users` → `null`, settling in one hop); the two existing admin-path assertions at
  `status-route.test.ts:323` pass unchanged.

### Wave 1 — tasks 2, 3 and 4 are parallel-safe (disjoint files)

**2 · Admin reads and writes on the `profiles` repo** `[after 1]`
- **Files:** `src/lib/db/repos/profiles.ts` (extend), `src/lib/db/repos/profiles.test.ts` (new),
  `src/lib/db/schema.ts` (add a read-only `auth.users` mirror)
- **Pattern:** the existing module's two functions; `client.ts`'s doc comment for the tone of the
  `dbAdmin` banner.
- **Build:** `listAccountsAsAdmin()` — `profiles` left-joined to `auth.users` for `last_sign_in_at`,
  ordered pending-first then newest-first, limit 500. `findAccountAsAdmin(id)`.
  `setAccountStatusAsAdmin({ actorId, targetId, status, stampApproval })` — one transaction that
  locks the active-admin set, refuses to empty it, and writes `status` (+ `approved_at`/`approved_by`
  on the first approval only, never rewriting an earlier decision). `countActiveAdmins()`.
  In `schema.ts`, `pgSchema("auth").table("users", { id, lastSignInAt })` with a comment that it is
  **read-only, `dbAdmin`-only, and must never be handed to `drizzle-kit generate`**.
- **Critical:** every statement in this section names `profiles` or `auth.users`. Nothing else.
  `updated_at` is left to the 0002 trigger.
- **Output:** the phase's only escalation surface, in one greppable block.
- **Check:** unit tests with a mocked transaction assert the pending-first ordering, that
  `stampApproval` does not overwrite a non-null `approved_at`, and that the guard's `for update`
  read happens before the write in the same transaction.

**3 · The pure transition table and guards** `[parallel with 2, after 1]`
- **Files:** `src/lib/admin/transitions.ts`, `src/lib/admin/transitions.test.ts`
- **Pattern:** `src/lib/tasks/status.ts` — exported constants, labels, pure predicates, no JSX, no db
  import.
- **Build:** `ADMIN_ACTIONS` (`approve` | `reject` | `suspend` | `reinstate`) with label, resulting
  status, whether it bans, whether it confirms before firing, and its button tone;
  `actionsFor(status)`; `resultOf(action)`; `canApply(action, status)`; the message constants the
  router and the UI both use.
- **Output:** the decision table from open item 3, as data, in one file.
- **Check:** every `(action, status)` pair is asserted — the legal ones produce the right next status,
  the illegal ones are refused; `actionsFor` returns exactly the buttons the table allows for each of
  the four statuses; reject and suspend are both marked destructive (criterion 13 has a source).

**4 · The Supabase Auth admin wrapper** `[parallel with 2, 3, after 1]`
- **Files:** `src/lib/supabase/admin.ts`, `src/lib/supabase/admin.test.ts`
- **Pattern:** `src/lib/supabase/server.ts` for shape; `src/lib/db/client.ts` for lazy init behind a
  missing-env guard so `next build` does not need the service-role key.
- **Build:** `adminAuthClient()` (service role, `persistSession: false`), `setAccountBanned(id, bool)`
  → `updateUserById(id, { ban_duration: banned ? BAN_DURATION : "none" })`,
  `sendRecoveryEmail(email, redirectTo)` → `resetPasswordForEmail`.
- **Critical:** this module is auth-only. It must not expose the service-role client to callers who
  could use it against `profiles` or a task table — the DB path is the repo's job.
- **Output:** one place that holds the service-role key, three named operations.
- **Check:** unit tests with the supabase client mocked assert the exact ban/unban arguments (the
  probe proved `"none"` is the string that lifts it) and that the recovery redirect is
  `authCallbackUrl("/reset-password")`.

### Wave 2

**5 · The `adminRouter`** `[after 2, 3, 4]`
- **Files:** `src/lib/trpc/routers/admin.ts`, `src/lib/trpc/routers/admin.test.ts`,
  `src/lib/trpc/routers/_app.ts` (**one line**: `admin: adminRouter`)
- **Pattern:** `profile.ts` and `task.ts` end to end — named Zod input exports, a `toPublicAccount()`
  projection because the link has **no transformer**, delegation to the repo.
- **Build:** `list` (query), `setStatus` (`{ userId, action }`), `sendPasswordReset` (`{ userId }`) —
  **all `adminProcedure`**. Guard order, and it matters for the error codes: self-target → `FORBIDDEN`;
  target missing → `NOT_FOUND`; illegal transition → `BAD_REQUEST`; last-admin → `CONFLICT`. On
  success, apply the ban side-effect *after* the row write, so a failed ban leaves a status change
  the admin can retry rather than a ban with no record.
- **Critical:** this file imports the `profiles` repo and `supabase/admin`, and **nothing from
  `repos/occurrences.ts` or `lib/tasks/`**. `toPublicAccount` returns exactly
  `{ id, email, displayName, status, role, createdAt, approvedAt, lastSignInAt }` — no task field can
  appear because none is fetched.
- **Output:** a typed admin router on `AppRouter`.
- **Check:** `createCallerFactory` unit tests — anonymous → `UNAUTHORIZED`; an active **member** →
  `FORBIDDEN`; a `suspended` admin → `FORBIDDEN` (the ladder rejects on status before role);
  self-target → `FORBIDDEN` with no repo call; `suspend` on a `pending` account → `BAD_REQUEST`
  before any query; the projection's key set asserted exactly.

### Wave 3 — tasks 6 and 7 are parallel-safe (disjoint files)

**6 · The admin shell and the `(admin)` route group** `[after 1]` — parallel-safe with 2–5
- **Files:** `src/app/(admin)/layout.tsx`, `src/app/(admin)/admin/page.tsx`,
  `src/app/(admin)/admin/users/page.tsx`, `src/components/admin/admin-shell.tsx`,
  `src/components/admin/admin-nav.tsx`, `src/components/admin/admin-shell.test.tsx`
- **Pattern:** `(app)/layout.tsx` for the server-side guard + Server Action sign-out;
  `(gate)/layout.tsx` for a sparse chrome; `Topbar.tsx` for the header geometry.
- **Build:** the layout calls `buildContext`, asks `routeForStatus` (passing `role`) and redirects if
  it answers, then **`notFound()` unless `profile.role === "admin"`**. `/admin` redirects to
  `/admin/users`. The shell is a topbar — logo, an "Admin" badge, `ADMIN_NAV`, theme toggle, the
  identity and sign-out — over a centred container. No sidebar, no breadcrumbs, no `DashboardShell`.
- **Critical:** criterion 11 — nothing in this tree may import `nav-config`'s `NAV` or link to
  `/today`, `/tasks` or `/overdue`. The logo links to `/admin/users`, not `HOME_HREF`.
- **Output:** a visibly distinct tier with exactly one destination.
- **Check:** a Testing Library render of the shell asserts there is no link whose href is a task
  route and that "Sign out" is reachable; the layout's guard order is covered by task 9's e2e.

**7 · The account list — table, cards, actions, confirm** `[after 3, 5]`
- **Files:** `src/components/admin/{account-list,account-row,account-card,account-actions,
  confirm-action-dialog,account-empty,account-skeleton}.tsx`,
  `src/components/admin/{account-presentation.ts,types.ts,use-account-actions.ts}`,
  `src/components/admin/{account-presentation.test.ts,accounts.test.tsx}`
- **Pattern:** `task-list.tsx` / `task-row.tsx` / `task-card.tsx` / `task-empty.tsx` /
  `task-skeleton.tsx` / `task-presentation.ts` / `use-task-actions.ts`, one for one. `Dialog` from
  phase 2 for the confirm step.
- **Build:** `<Table>` in `hidden md:block` and a stacked `md:hidden` card list, **each with its own
  loading, empty and error states**. Columns: Account (email + display name), Signed up, Last sign-in,
  Status (a `Badge` — `warning` pending, `success` active, `danger` rejected, `neutral` suspended),
  Actions. Both presentations render the **same `<AccountActions>`**, so `Approve <email>` /
  `Suspend <email>` are spelled once. Destructive actions open `<ConfirmActionDialog>` before firing
  (criterion 13); the in-flight button uses `loading` (criterion 14). The caller's own row shows a
  "You" badge and no actions.
- **Critical:** design tokens only, no raw hex, no nested boxes inside a card. Skeleton heights match
  the real row (an `h-9` button block, not an `h-4` bar) so resolving causes no shift.
- **Output:** the whole admin surface, responsive, with no task data anywhere in it.
- **Check:** Testing Library — approving calls `setStatus` once with `{ action: "approve" }`; a
  suspend does **not** fire until the dialog is confirmed; a pending row offers Approve and Reject and
  not Suspend; the row and the card produce byte-identical accessible names for the same account; the
  admin's own row renders no action buttons.

### Wave 4

**8 · Wire the page, and prove the isolation** `[after 5, 6, 7]`
- **Files:** `src/app/(admin)/admin/users/page.tsx` (fill in),
  `tests/integration/rls-boundary.test.ts` (**append one block — do not restructure**),
  `src/lib/admin/isolation.test.ts`
- **Pattern:** the existing `task_occurrence` block for the boundary spec's shape.
- **Build:** the page is a server component that renders `<AccountList />` under an `h1` and one line
  of explanation. The new boundary block — *"the admin tier reads accounts, never tasks"* — asserts:
  an admin's `withUser()` session still sees **zero** `task_occurrence` rows after account operations;
  `listAccountsAsAdmin()` returns every profile and its key set contains **no** task field;
  `authenticated` still gets `permission denied` on `auth.users` (finding 5); and
  `setAccountStatusAsAdmin` refuses to empty the active-admin set.
  `isolation.test.ts` is the greppable half of criterion 8: it reads the admin source files off disk
  and asserts none mentions `occurrences`, `task_occurrence`, `taskOccurrence` or `lib/tasks`, and
  that `dbAdmin` is imported by exactly the files this project sanctions.
- **Critical:** append to the boundary spec. Phase 3 is editing the same file.
- **Output:** criteria 7, 8 and 9 asserted rather than asserted-about.
- **Check:** `pnpm test:integration` green, including the pre-existing 27.

**9 · End to end, and the screenshots** `[after 8]`
- **Files:** `e2e/admin.spec.ts`, `e2e/screenshots.spec.ts` (append an admin block),
  `e2e/helpers/accounts.ts` (only if a helper is genuinely missing)
- **Pattern:** `e2e/auth-flow.spec.ts` for the journey shape; `fillForm()` for **every** field;
  `getByRole` for **every** selector.
- **Build:** the full journey through the browser — an admin signs in and lands on `/admin/users`
  (criterion 1's "no re-signup" path); approves a pending user, who then reaches `/today`; rejects
  another, who sees `/no-access`; suspends a user **holding a live session**, whose next request
  lands on `/no-access`; reinstates them and they are back in. A member on `/admin/users` gets 404.
  Password reset: click, then read the recovery mail out of Mailpit, follow it, set a new password,
  and sign in with it.
- **Critical:** never a bare `fill()`; never a CSS or test-id selector — both presentations are in the
  DOM at once and only the role engine picks the visible one. The suspended-session step must sign
  the target in **first**, or it proves nothing the phase-1 spec did not already prove.
- **Output:** criteria 1–6 and 12–14 walked by a browser.
- **Check:** `pnpm test:e2e` green on both projects; screenshots exist for `/admin/users` in light
  and dark, desktop and mobile (criterion 16).

## Verify gates

From `AGENTS.md` — not guessed:

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Plus, because this phase touches data access: `pnpm test:integration`, and `pnpm test:e2e`. Both need
this worktree's stack and its env sourced first:

```
cd .../devtask-pro-worktrees/phase-5-admin
set -a; . ./.env.worktree; set +a
```

## Branch / PR target

Branch `phase-5-admin` → **PR into `main`**, opened by a human. The session never merges, never
pushes, and never stages `supabase/config.toml` — that file is locally rewritten to read its ports
from `env(...)` so this worktree's stack can run beside main's, and committing it would break main.

## Risks & rollbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A ban changes where a suspended user lands**, silently breaking criterion 3 and the phase-1 e2e. | Was the top risk | **Measured, not assumed** (findings 1–3): `/user` still returns 200 after a ban, so the status read still decides and `/no-access` still wins. |
| **`dbAdmin` reaches a task table.** No policy will catch it; every assertion in the boundary spec would still pass. | Medium | The escalation lives in one banner-commented block of one file, every function is `…AsAdmin`, and task 8 asserts by source grep that no admin file names a task module. |
| **The new role branch creates a redirect loop.** An admin bounced from `/today` to a path they are also bounced from. | Medium | The fixed-point property test in `status-route.test.ts` is extended to the admin caller; the rule is an inversion around `/admin`, so the destination is inside the allowed set by construction. |
| **Members lose their 404 on `/admin/*`.** Adding a redirect for non-admins would bypass the layout and quietly weaken criterion 5. | Medium | The role rule fires only for `role === "admin"`. `status-route.test.ts:323` and `auth-flow.spec.ts:94` both pin the member path and are run unchanged. |
| **Two admins suspend each other and leave zero admins.** | Low | The guard's read is `for update` inside the write's own transaction, so the second caller blocks and then fails (task 2). |
| **Row and card action names drift**, so an e2e passes on one project and times out on the other. | Low | They cannot: both render the same `<AccountActions>`, and a test asserts the two accessible names are identical. |
| **The password-reset e2e reads main's Mailpit** and either fails or, worse, matches a stale message. | Medium | `MAILPIT_URL` is set to `:54444` in the gitignored `.env.local`, and the spec calls `clearInbox()` before the journey. |

**Rollback:** every task is one atomic commit on `phase-5-admin`, nothing is deployed, and **there is
no migration** — so rollback is `git reset` with no database state to unwind.

## Deferred to later phases

- Pagination, search and filtering of the account list. The cap is 500 rows with a comment; the day
  that is not enough is the day this earns a design.
- An audit log, and any UI for `approved_by` beyond stamping it.
- Admin-to-admin promotion. Creating an admin stays `pnpm admin:create`, and demotion has no UI —
  which is why the last-admin guard is about `status`, not `role`.
- Editing a member's profile fields. Admins govern access, not content (brief, out of scope).
- Email reminders (phase 6) — the other legitimate `dbAdmin` caller, and the one that will make this
  phase's banner comment carry two entries instead of one.
