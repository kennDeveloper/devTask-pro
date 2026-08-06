# devtask-pro phase 5 — discuss

> GSD stage 1 of 5 · **Discuss** → Plan → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md`, `docs/gsd/phase-2-discuss.md` · Branch: `phase-5-admin`
> Phase 5 of 6: **admin tier** · Mode: interactive
> Built in a dedicated worktree alongside phase 3; the two do not share files. See "Parallel build".

## Request

The admin tier that governs *access to the app* and nothing else. An admin approves or rejects
signups, suspends and reinstates accounts, and triggers a password-reset email. They see account
metadata only — email, display name, signup date, status, last sign-in — and **never** task data of
any kind, including aggregate counts.

Phase 1 built the gating: `profiles.status` drives `routeForStatus()`, the proxy reads it live per
request, and `adminProcedure` already sits at the top of the tRPC ladder. What is missing is the
tier that *changes* those statuses. Every phase-1 gate is currently exercised by hand-editing rows.

## In scope

- **`(admin)` route group** with a **deliberately sparse shell** — its own chrome, no task nav.
- **`/admin/users`** — the account list: email, display name, signup date, status, last sign-in.
- **Account actions** — approve, reject, suspend, reinstate.
- **Trigger a password-reset email** for a user.
- **`adminRouter`** on `adminProcedure`, and the admin-scoped functions on the `profiles` repo.
  These are the legitimate `dbAdmin` callers named in `AGENTS.md`.
- **Suspension additionally bans in Supabase Auth**, so a live session dies at once rather than
  working until the JWT expires (criterion 4).
- A `rls-boundary` assertion that an admin session reading task data gets **zero rows**.

## Out of scope

- **Any task data whatsoever** — no counts, no "3 open tasks" column, no charts. This is not a
  nice-to-have omission; it is the guarantee the RLS policies exist to give. Adding it requires
  changing the decision in `docs/gsd/devtask-pro-v1.md` first.
- Recurrence — **phase 3**, built in parallel in its own worktree. Do not touch
  `src/lib/recurrence/**`, `src/components/tasks/**`, or the occurrences repo.
- Tags and search — **phase 4**. Email reminders — **phase 6**.
- Admin-editable profile fields (renaming a user, changing their timezone). Admins govern access,
  not content.
- Audit log UI, bulk actions, CSV export, admin-to-admin promotion UI.
- Self-serve account deletion. Creating admins stays `scripts/create-admin.ts` / `pnpm admin:create`.

## Acceptance criteria

Numbers in brackets map to `devtask-pro-v1.md`. Phase 1 built the *gates*; this phase builds the
actions that drive them, so 1–4 are re-asserted end-to-end through the admin UI rather than by
editing rows by hand.

**Access control**
1. **[2]** After an admin clicks Approve, that user reaches `/today` on next navigation with no
   re-signup — asserted through the browser, not by a direct DB write.
2. **[3]** A rejected user sees `/no-access` and cannot reach `(app)` routes.
3. **[4]** Suspending a user **with a live session** terminates it — their next request lands on
   `/no-access`. This requires the Supabase Auth ban, not just the status flag.
4. Reinstating a suspended user restores access without a re-signup.
5. **[5]** A non-admin requesting any `/admin/*` route gets a 404 or redirect, **not** a rendered
   admin page — enforced in the `(admin)` layout, and independently at `adminProcedure`.
6. **[7]** Admin-triggered password reset delivers a recovery email; the link sets a new password
   and signs the user in. Asserted against Mailpit.

**The guarantee**
7. **[6]** An admin's session reading `task_occurrence` returns **zero rows** — asserted in
   `tests/integration/rls-boundary.test.ts`. Role does not defeat RLS.
8. No admin route, procedure, or component imports anything from `src/lib/db/repos/occurrences.ts`,
   and no admin query names a task table. Greppable, and asserted.
9. `dbAdmin` appears only in the admin account-operation path and the existing bootstrap script —
   nowhere else this phase adds.
10. An admin cannot change their own role or status through any admin procedure, and cannot suspend
    the last remaining active admin.

**Presentation**
11. The admin shell carries **no task navigation** — no Today, Tasks, or Overdue destination is
    reachable or rendered in an admin session.
12. The users list is a `<Table>` at `md`+ and a stacked card list below it, each with its own
    loading and empty states. Row and card name their controls identically
    (`Approve <email>`, `Suspend <email>`), per the e2e rule in `AGENTS.md`.
13. Destructive actions (reject, suspend) confirm before firing.
14. Buttons tied to an in-flight action use the `Button` `loading` prop; skeletons mirror the real
    layout so resolving causes no layout shift.
15. **[23]** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
16. **[24]** Playwright screenshots every route without error, mobile and desktop.

## Decisions

- **The admin tier gets its own sparse shell, not the `DashboardShell`.** Confirmed with the user
  this session. The shell was built around task navigation; reusing it means an admin session
  renders a component whose whole job is linking to task routes, and the separation that criterion 6
  proves in the database should be visible in the UI too. `nav-config.tsx` already anticipates this
  — the `comingSoon` mechanism was kept explicitly for the admin tier.
- **Suspension bans in Supabase Auth as well as setting the status.** A status flag alone leaves a
  valid JWT working until it expires, which fails criterion 4 outright. The proxy's live
  `profiles.status` read covers page navigation; the ban covers everything else.
- **Migration number is `0006` — if one is needed at all.** `profiles` already carries `role`,
  `status`, `approved_at` and `approved_by`, and `last_sign_in_at` is readable from
  `auth.users` through `dbAdmin`. Plan should confirm no migration is required rather than adding
  one reflexively. The number is reserved because phase 3 is being built in parallel and takes
  `0005`.
- **Admin reads of `profiles` go through `dbAdmin`, and that is the carve-out, not a precedent.**
  `AGENTS.md` names exactly three legitimate callers; this phase is one of them. Every other read
  in the app still goes through `withUser()`.
- **Self-protection lives in the procedure, not the UI.** Criterion 10 is enforced server-side —
  hiding a button is presentation, not a guarantee.

## Constraints

- **`dbAdmin` bypasses RLS entirely.** It is correct here for `profiles` and catastrophic anywhere
  near a task table. Every admin query must be reviewed on the assumption that no policy will
  catch a mistake.
- **`activeProcedure` is not enough for admin routes** — use `adminProcedure`, which is already
  built. Validate every input with Zod at the boundary.
- **Access rules belong in `routeForStatus()`** (`src/lib/access/status-route.ts`), not in the
  proxy. It has a fixed-point property test that catches redirect loops. If `/admin/*` needs a new
  always-allowed path, add it there.
- **The SQL is authoritative**; `src/lib/db/schema.ts` is a typed mirror updated by hand. Never
  `drizzle-kit generate`.
- Business logic in `src/lib/**`, never inline in a component or route handler.
- Design tokens only; no raw hex, no gradients, no heavy shadows. Hairline `line` borders do the
  structural work. No sections inside cards. Lists on mobile are cards, never tables.
- **e2e: never a bare `fill()`** — go through `fillForm()`. Select by role, never CSS or test id.
- Next.js 16 renamed `middleware` → `proxy` and is newer than most training data — read
  `node_modules/next/dist/docs/` before writing framework code.

## Parallel build

This phase is built in a git worktree at `../devtask-pro-worktrees/phase-5-admin`, against its
**own** Supabase stack (API 54441, DB 54442, Studio 54443, Mailpit 54444) with `next dev` on 3002.
Phase 3 runs simultaneously on 5443x / 3001. Main is untouched on 5442x / 3000.

- `supabase/config.toml` here is locally modified to read every host port from `env(...)`, sourced
  from `.env.worktree`. **That edit must never be staged** — it would break `main`'s stack. Revert
  it before the PR. Stage files explicitly; never `git add -A`.
- Files phase 3 also touches: `src/lib/trpc/routers/_app.ts` (one line each) and
  `src/components/dashboard/nav-config.tsx`. Keep edits there minimal and surgical.
- `tests/integration/rls-boundary.test.ts` — **add a block, do not restructure the file.** Phase 3
  is editing it too.

## Open items for Plan

1. **Where does the admin land after sign-in?** `HOME_HREF` is `/today`, which an admin arguably
   should not see at all. Does an admin get redirected to `/admin/users`, and if so, does
   `routeForStatus()` grow a role dimension — or is that the `(admin)` layout's job?
2. **Can an admin also be an ordinary user?** The role is a single column, so an admin has task
   rows of their own that RLS still scopes to them. Decide whether the admin shell offers a way
   back into the task app, or whether the tiers are fully disjoint in the UI.
3. **Reject vs suspend — is reject reversible?** Both land on `/no-access`. If reject is terminal
   and suspend is not, the UI must say so; if they differ only in wording, consider whether both
   statuses earn their place.
4. **Password reset: Supabase `resetPasswordForEmail` or the admin `generateLink` API?** The former
   is the ordinary user flow and needs no `dbAdmin`; the latter gives the admin a link but risks
   handing them a credential-bearing URL. Leaning the former — Plan decides.
