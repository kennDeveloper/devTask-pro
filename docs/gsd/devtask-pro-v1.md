# devtask-pro v1 — discuss

> GSD stage 1 of 5 · Discuss → Plan → Execute → Verify → Ship
> Status: **complete** — ready for `gsd-plan`.
> Mode: interactive (user pauses at forks). Switches to autonomous only on explicit say-so.

## Request

A daily task tracker where every user manages their own work **in private**. Tasks are either
one-off (with an optional deadline) or recurring on Google-Calendar-style repeat rules. Each task
moves `Todo → In Progress → Done`, carries a manually-set progress percentage, and anything past
its deadline surfaces in an **Overdue** bucket. A separate **Admin** tier governs access to the app
— approve/reject signups, suspend accounts, trigger password resets — and never sees task data.

## In scope

**User tier**
- Email/password auth (sign up, sign in, forgot/reset password) via Supabase Auth.
- One-off tasks: title, notes, optional deadline, status, progress %.
- Recurring tasks: a repeat rule that generates trackable occurrences, each with its own
  independent status and progress %.
- Status workflow `todo → in_progress → done`, freely reversible.
- Manual progress percentage, 0–100, independent of status.
- Overdue bucket, derived from deadline vs. now in the user's timezone.
- Notes/description on a task.
- Search by title + filter by status and date range.
- User-defined tags, with a tag manager and filter-by-tag.
- Email reminders ahead of a deadline.
- Per-user timezone, captured at signup and editable in settings.

**Admin tier**
- Users list with account status; approve, reject, suspend, reinstate.
- Trigger a password-reset email for a user.
- Account metadata only — email, display name, signup date, status, last sign-in.

## Out of scope

Recorded deliberately; none of these are v1.

- **Any sharing, assignment, teams, or org/multi-tenancy.** Kickoff's generated schema is
  org-scoped; devtask-pro drops `organisation_id` entirely and scopes on `user_id`.
- Admin visibility into task data of any kind, **including aggregate counts**.
- Subtasks, dependencies, checklists, attachments, comments.
- Exotic recurrence: `EXDATE`/`RDATE` exceptions, "skip this one occurrence", editing a single
  occurrence's rule, `BYSETPOS` beyond nth-weekday-of-month.
- Calendar sync (Google/ICS import or export) — "Calendar-style" describes the *rule vocabulary*
  only, not integration.
- In-app or push notifications; reminders are email only.
- Self-serve account deletion, data export, audit log UI.
- OAuth/social login, MFA, SSO.
- Mobile app. Responsive web only.

## Acceptance criteria

These become the `gsd-verify` checklist.

**Access control**
1. A brand-new signup lands on `/pending` with an "awaiting approval" message and cannot reach any
   `(app)` route.
2. After an admin approves, that user reaches `/today` on next navigation with no re-signup.
3. A rejected user sees `/no-access` and cannot reach `(app)` routes.
4. Suspending a user with a live session terminates it — their next request lands on `/no-access`.
5. A non-admin requesting any `/admin/*` route gets 404/redirect, not a rendered admin page.
6. An admin's session reading any task table directly returns **zero rows** (RLS proof, asserted in
   an integration test — not just a UI assertion).
7. Admin-triggered password reset delivers a recovery email; the link sets a new password and signs
   the user in.

**Tasks**
8. Creating a one-off task with no deadline never marks it overdue, however old it gets.
9. A task with `deadline < now` and status ≠ `done` appears in Overdue **and** retains its
   underlying `todo`/`in_progress` status in the UI.
10. Marking an overdue task `done` removes it from Overdue immediately, with no job run.
11. Editing an overdue task's deadline into the future removes it from Overdue immediately.
12. Progress % accepts 0–100 inclusive, rejects out-of-range at the Zod boundary, and is fully
    independent of status (a `done` task may sit at 40%).

**Recurrence**
13. `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` produces occurrences on exactly the expected dates across a
    12-week window, asserted by unit test on the pure `expand()` function.
14. Setting occurrence #3 of a series to `in_progress` at 60% persists that row and leaves
    occurrences #1, #2, #4 untouched.
15. Editing a series' rule changes only future **untouched** occurrences; occurrences that already
    carry status or progress keep theirs.
16. Each of the five end conditions behaves: never / on `<date>` / after `<N>` occurrences, and the
    monthly `by_date` vs `by_nth_weekday` modes both expand correctly (including "last Friday").
17. Deleting a series removes untouched future occurrences and leaves completed history intact.

**Timezone**
18. For a user in `Asia/Manila`, a task due 23:00 local is not overdue at 22:00 local, regardless of
    server timezone.
19. The "today" list boundary is midnight in the user's timezone on both SSR and client — no
    hydration flash showing a different day.
20. A recurring task set to 09:00 fires at 09:00 local across a DST transition for zones that
    observe one.

**Reminders**
21. A reminder for a given occurrence sends **at most once**, proven by running the job twice.
22. No reminder is sent for an occurrence already marked `done`.

**Gates**
23. `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
24. Playwright screenshots every route without error, mobile and desktop.

## Decisions

- **Per-user ownership, not org-scoped** — because every task is private to one person; kickoff's
  `organisation_id` convention has no tenant to scope to and would be dead weight on every table.
- **Supabase Auth + Drizzle + tRPC, not Clerk + Prisma** — because the user pointed at
  lightning-kickoff, which is the house stack; this overrides the `nextjs-fullstack` skill.
- **Lazy-materialized occurrences** — a `task_series` holds the rule; `task_occurrence` rows are
  computed for the viewed window and written on first touch (any status or progress change).
  Because occurrences carry independent state, they must be rows eventually; materializing on touch
  gets that without a scheduler owning correctness, and rule edits only disturb untouched rows.
  A one-off task is a `task_occurrence` with `series_id = NULL` — one read path, not two.
- **Overdue is derived, never stored** — `deadline < now() AND status <> 'done'`. Correct the
  instant a deadline is edited or a clock ticks, needs no job, and preserves the real status
  underneath (a stored 4th status would destroy whether the task was Todo or In Progress).
- **Postgres RLS on task tables, keyed to `auth.uid()`, plus tRPC role checks** — so "admin never
  sees tasks" is a database guarantee, not a code-review promise. A forgotten `.where()` cannot leak.
  Cost: user-facing task reads run on the user's own Supabase connection, never `service_role`.
- **`service_role` is reserved for the reminder job and admin account operations only** — never a
  user-facing task read. This is the explicit carve-out that keeps criterion 6 honest, and it is a
  review checkpoint, not an honour system.
- **Structured repeat rule, serialized to an RRULE string** — typed columns matching Google
  Calendar's standard repeat menu, expanded by a small pure function we own and unit-test. Zero
  dependency, fully testable; adopting the `rrule` package later is additive because the stored
  string is already RFC 5545-valid.
- **`profiles.status` is the source of truth for access, enforced in middleware** — a DB trigger
  mirrors `auth.users` into `profiles` with `status='pending'`. Distinct statuses let each state get
  its own honest screen. Suspension **additionally** bans in Supabase so live sessions die at once;
  a status flag alone would leave an active JWT working until expiry.
- **Per-user timezone on the profile** — captured from the browser at signup, editable later. "Today"
  boundaries and recurrence expansion resolve identically on server and client, so SSR and hydration
  agree. Browser-local-only would leave the server unable to compute a correct overdue filter.
- **Series carries template tags, copied onto occurrences at materialization** — consistent with how
  every other series field propagates; editing series tags affects future untouched occurrences only.
- **Reminders: Vercel Cron → a route handler, delivery over SMTP** — the project deploys to Vercel
  per kickoff, so cron is in-platform with nothing extra to provision. *Amended in phase 6:* the
  transport is SMTP rather than Resend's HTTP API. Resend speaks SMTP too, so this satisfies the
  original intent while letting the local stack's mail catcher exercise the very transport that runs
  in production — instead of a production-only branch nothing local ever executes.
- ~~**The reminder job materializes occurrences inside its horizon**~~ — **superseded in phase 6.
  The job writes nothing to `task_occurrence`.**

  This decision was made before the recurrence engine existed, and phase 3 then built criteria 15 and
  17 on the opposite premise. `src/lib/db/repos/series.ts` states the mechanism outright: untouched
  future occurrences vanish on a rule edit or a series delete **because they were never rows**. There
  is no untouched-row cleanup anywhere in the codebase, because until phase 6 nothing but a user's
  own touch could create a row. A materializing job would therefore leave rows on dates a later rule
  edit no longer names — and the read path is a union with rows winning, not a filter, so they would
  still appear — and rows that outlive a soft-deleted series.

  Instead, `reminder_log` carries the occurrence's **identity** rather than its row id:
  `(series_id, occurs_on)` for an occurrence of a series, materialized or not, and `(occurrence_id)`
  for a one-off. Because that identity does not change when somebody later touches the date, no
  second reminder fires after materialization — a property that falls out rather than needing
  handling. Two partial unique indexes enforce at-most-once; the job claims a row with
  `on conflict do nothing` and sends only if the claim won.

  The trade-off, taken deliberately: a send that throws after a successful claim is a **missed**
  reminder, not a retried one. The criterion is *at most once*.

  See `supabase/migrations/0007_reminders.sql` and `docs/gsd/phase-6-discuss.md`.
- **The reminder job runs inside RLS** — phase 6. It escalates once, through
  `profiles.listActiveRecipientsAsAdmin()` inside the existing fence, to learn who exists; then opens
  `withUser({ sub })` per account and reads that person's tasks through the ordinary feed. So the
  reminder sees exactly what the user sees, and phase 6 adds no application module to the sanctioned
  `dbAdmin` set. The cost is one transaction per account per run, which is the right trade here.

## Constraints

- **Gates**: `pnpm typecheck && pnpm lint && pnpm build && pnpm test` must pass before any PR.
  Evidence before assertions — see `verification-before-completion`.
- **Branch model**: `feature → main`. The session opens a PR and **never merges**.
- **Kickoff conventions carry over** (from `lightning-kickoff/CLAUDE.md`):
  - One repo module per table in `src/lib/db/repos/`; routes and lib call the repo, never Drizzle
    directly.
  - Validate at the boundary with Zod — every tRPC input and route handler body.
  - Business logic in `src/lib/**`, never inline in a component or route handler.
  - Tests sit next to the code they test (`foo.ts` ↔ `foo.test.ts`); only cross-cutting suites live
    in `tests/`.
  - Types and reusable helpers live outside component files; predicates go in a lib file, not JSX.
  - **No sections inside cards.** One flat piece of content per card.
  - **Lists on mobile are cards, never tables** — a `<Table>` needs a stacked `md:hidden` card list,
    each with its own loading and empty states.
  - Loading states are skeletons mirroring the real layout, so resolving causes no layout shift.
  - Flat clean-white design driven by design tokens. No gradients, no heavy shadows.
- **Stack is fixed**: Next.js 16 App Router + React 19, tRPC 11, Drizzle over Supabase Postgres,
  `@supabase/ssr`, Tailwind v4 + shadcn/ui, Zod 4, Vitest + Testing Library, Playwright, pnpm 10,
  Node 22.
- Next.js 16 is newer than most training data — consult `node_modules/next/dist/docs/` before
  writing framework code.
- `create-next-app` runs into a directory that already contains `docs/` — confirm in Plan that this
  does not trip its conflict check, or scaffold to a temp dir and merge.
- Set `"build": "next build"` — `create-next-app@16` ships
  `--experimental-build-mode compile`, which 500s every SSR page in production with
  `ReferenceError: __dirname is not defined`.

## Data model sketch

Not final — `gsd-plan` owns the real schema. Enough to start planning warm.

```
profiles                 mirrors auth.users via trigger
  id            uuid PK → auth.users(id)
  email, display_name, timezone
  role          member | admin
  status        pending | active | rejected | suspended
  approved_at, approved_by, last_sign_in_at, created_at, updated_at

task_series              the repeat rule (recurring only)
  id, user_id, title, description
  freq          daily | weekly | monthly | yearly
  interval      int
  byweekday     text[]                    -- weekly
  month_mode    by_date | by_nth_weekday  -- monthly
  month_day | nth_week + nth_weekday
  starts_on, deadline_time, default_progress
  ends_mode     never | on | after
  ends_on, ends_count
  rrule         text  -- serialized, RFC 5545-valid
  reminder_lead_minutes
  created_at, updated_at, deleted_at

task_occurrence          the trackable unit; one-off ⇒ series_id NULL
  id, user_id, series_id?
  title, description, occurs_on date, deadline_at timestamptz?
  status        todo | in_progress | done
  progress_pct  int 0..100
  reminder_lead_minutes, completed_at, created_at, updated_at
  UNIQUE (series_id, occurs_on) WHERE series_id IS NOT NULL

tags               id, user_id, name, color   UNIQUE (user_id, lower(name))
series_tags        series_id, tag_id          -- template
occurrence_tags    occurrence_id, tag_id      -- actual

reminder_log       -- at-most-once. AMENDED IN PHASE 6, see the decision above:
  id, user_id      -- keyed by the occurrence's IDENTITY, not by a row id, because
  series_id?       -- most upcoming occurrences are projections and the job must
  occurrence_id?   -- not materialise them. Exactly one of the two is set.
  occurs_on, deadline_at, sent_at
  UNIQUE (series_id, occurs_on) WHERE series_id IS NOT NULL
  UNIQUE (occurrence_id)        WHERE occurrence_id IS NOT NULL
```

RLS: `profiles`, `task_series`, `task_occurrence`, `tags`, and both join tables all carry
`USING (user_id = auth.uid())`. Admin reads of `profiles` go through `service_role` in an
admin-only tRPC router.

## Likely files

```
src/app/(marketing)/page.tsx
src/app/(auth)/sign-in|sign-up|forgot-password|reset-password/page.tsx
src/app/auth/callback/route.ts
src/app/(gate)/pending|no-access/page.tsx
src/app/(app)/today|tasks|tasks/[id]|overdue|settings/page.tsx
src/app/(admin)/admin/users|admin/users/[id]/page.tsx
src/app/api/trpc/[trpc]/route.ts
src/app/api/cron/reminders/route.ts
src/middleware.ts                        status → screen routing
src/lib/supabase/{client,server}.ts
src/lib/db/schema.ts
src/lib/db/migrations/                   + RLS policies, auth.users trigger
src/lib/db/repos/{profiles,series,occurrences,tags,reminders}.ts
src/lib/recurrence/{expand,serialize,parse}.ts    pure, heavily unit-tested
src/lib/tasks/{overdue,progress,status}.ts        pure predicates
src/lib/time/{user-tz,day-boundary}.ts
src/lib/email/{send,templates}.ts
src/lib/trpc/routers/{task,series,tag,profile,admin}.ts
src/components/tasks/…  src/components/admin/…
supabase/{config.toml,seed.sql}          seed the first admin
e2e/screenshots.spec.ts
```

## Open items for Plan

- Milestone/phase split — this is more than one execution pass. Suggested cut:
  **1** scaffold + auth + gating · **2** one-off tasks + overdue · **3** recurrence engine ·
  **4** tags + search/filter · **5** admin tier · **6** reminders.
- First-admin bootstrap: seed via `supabase/seed.sql` from an env-provided email, vs. a one-off
  promote script. Plan decides.
- Whether `(app)` and `(admin)` share the kickoff `DashboardShell` or the admin tier gets a visually
  distinct, deliberately sparse shell.
