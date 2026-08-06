# devtask-pro phase 2 — plan

> GSD stage 2 of 5 · [Discuss ✓] → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/phase-2-discuss.md` · Branch: `phase-2-tasks` (stacked on `phase-1-foundation`)
> Phase 2 of 6: **one-off tasks + overdue**

## Goal

A user creates one-off tasks, moves them through `todo → in_progress → done`, sets a progress
percentage by hand, and sees anything past its deadline in a derived **Overdue** bucket — and
**criterion 6 finally closes**: an admin's session reading `task_occurrence` returns zero rows,
proven in an integration test against a real task table rather than by analogy on `profiles`.

## Research findings (verified in the code, not assumed)

1. **`0003_rls_policies.sql` is the template to follow, and it is explicit about why.** Grants come
   first (`grant select, update on … to authenticated; grant all … to service_role;` — `anon` gets
   nothing), then policies using `(select auth.uid())` rather than a bare `auth.uid()`, so the
   planner hoists it into an InitPlan and evaluates once per statement instead of once per row.
   Copy that shape exactly.
2. **`task_occurrence` needs policies `profiles` does not.** `profiles` deliberately has no INSERT
   policy (the trigger creates rows) and no DELETE policy (auth cascades). Tasks are user-created and
   user-deleted, so this table needs **all four** — select, insert, update, delete — each keyed on
   `user_id = (select auth.uid())`, and INSERT needs a `with check` or a user could insert a row
   owned by someone else.
3. **No escalation-guard trigger is needed here.** The `profiles` guard exists because that table
   holds `role`/`status`. `task_occurrence` has no privileged column; a plain policy set is
   sufficient. Do not cargo-cult the trigger.
4. **`withUser(claims, fn)`** (`src/lib/db/rls.ts:68`) takes `{ sub, email? }` and hands the callback
   a transaction handle. There is no ambient scoped `db` — the callback signature is the only
   scoped path. `withOptionalUser` exists for the anonymous case.
5. **The procedure ladder is already built** (`src/lib/trpc/server.ts`): `publicProcedure` :133,
   `protectedProcedure` :154, `activeProcedure` :187, `adminProcedure` :215. `activeProcedure` is
   the floor for every task procedure. `ActiveContext` guarantees `ctx.profile` is present.
6. **`(app)/layout.tsx` already loads the profile server-side** via `buildContext(supabase)`. Pages
   in that group can do the same to get `profile.timezone` **on the server** — this is what makes
   criterion 19 achievable without a hydration flash.
7. **`profile.ts` is the router pattern to copy**: Zod input schema as a named export, a
   `toPublicX()` projection because **the tRPC link has no transformer** so `Date` crosses the wire
   as a string, and `withUser()` around every query with a belt-and-braces `.where()`.
8. **The repo convention is violated today.** `AGENTS.md` mandates `src/lib/db/repos/` with routes
   never calling Drizzle directly, but the directory does not exist and `profile.ts:124` calls
   `tx.update(profiles)` inline. Task 2 establishes it; task 9 retrofits `profiles`.
9. **UI primitives present**: Badge, Button, Card, Field, Input, Separator, Skeleton (+
   `TableRowsSkeleton`), Table, Tabs, Text. **Absent**: Dialog, Select, Textarea, Checkbox, Slider.
   **Zero Radix packages are installed** — Tabs is hand-rolled with its own context, and
   `settings-screen.tsx:236` uses a raw `<select>` with a comment saying so.
10. **`nav-config.tsx:21-22`** marks Tasks and Overdue `comingSoon: true`, and `isNavItemActive()`
    returns false for such items. Un-flagging them is a one-line change plus its test.
11. **`tests/integration/rls-boundary.test.ts`** already builds the two-user + admin harness and its
    header comment says in writing that phase 2 re-points it. Extend, do not rewrite.

## Decisions taken at plan time

- **Overlays use the native `<dialog>` element**, not Radix and not a hand-rolled trap. The browser
  supplies the focus trap, Escape, top layer and inert background — the parts that are easy to get
  subtly wrong and that nobody notices are broken. Zero new dependencies, consistent with the
  hand-rolled house style. **`::backdrop` must take an explicit colour, not `var(--…)`** — see the
  `@theme inline` trap in the constraints below.
- **Hard delete for occurrences, with a confirm step.** The brief's data-model sketch puts
  `deleted_at` on `task_series` and **not** on `task_occurrence`, and phase 3's criterion 17 only
  requires that *untouched future* occurrences disappear while completed history survives. Soft
  delete here would buy nothing and cost a nullable filter on every read.
- **Progress is a native `<input type="range">` (step 1) with a numeric readout.** Criterion 12's own
  example is *"a `done` task may sit at 40%"*, which rules out a stepped 0/25/50/75/100 select
  outright. A range input is native, accessible and free; Zod enforces `int().min(0).max(100)` at
  the boundary regardless of what the control allows.
- **Status is a native `<select>`**, matching `settings-screen.tsx` rather than inventing a second
  idiom for the same job one phase later.
- **"Today" is resolved on the server and passed down as an ISO date string.** The page is a server
  component that reads `profile.timezone`, computes the date, and hands it to the client. No client
  code calls `new Date()` to decide which day it is — that is exactly what produces the criterion-19
  hydration flash.
- **One overdue definition, asserted from both ends.** The pure `isOverdue()` predicate drives the
  UI; the SQL predicate drives the query; task 4's test proves they agree on a shared fixture set.
  Two definitions that drift is the realistic failure mode here.

## Tasks

Each is sized for one fresh context window. `[seq]` must follow its predecessor; tasks sharing a
wave touch disjoint files and are parallel-safe.

### Wave 0

**1 · `task_occurrence` migration, schema mirror, RLS** `[seq]` — **highest risk in the phase**
- **Files:** `supabase/migrations/0004_task_occurrence.sql`, `src/lib/db/schema.ts`
- **Pattern:** `0003_rls_policies.sql` verbatim in shape — grants block first, then policies with
  `(select auth.uid())`. Column conventions from `0001`.
- **Build:** `id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users(id)
  on delete cascade`, `series_id uuid` (**nullable, no FK — phase 3 adds it**), `title text not null`,
  `description text`, `occurs_on date not null`, `deadline_at timestamptz`,
  `status text not null default 'todo' check (status in ('todo','in_progress','done'))`,
  `progress_pct int not null default 0 check (progress_pct between 0 and 100)`,
  `completed_at timestamptz`, `created_at`, `updated_at`. Reuse the `touch_updated_at()` trigger
  from `0002`. Indexes on `(user_id, occurs_on)` and `(user_id, deadline_at)`.
  **All four policies** — select/insert/update/delete — each `using (user_id = (select auth.uid()))`,
  and INSERT additionally `with check (user_id = (select auth.uid()))` or a user can create a row
  owned by someone else. Grants: `select, insert, update, delete` to `authenticated`; `all` to
  `service_role`; nothing to `anon`.
- **Output:** `pnpm db:reset` applies cleanly; `schema.ts` mirrors it by hand with a comment naming
  what SQL holds that Drizzle cannot express.
- **Check:** `pnpm db:reset` exits 0; a `select` as `anon` fails on permission, not on RLS.

### Wave 1 — tasks 2, 3 and 4 are parallel-safe (disjoint files)

**2 · The occurrences repo** `[after 1]`
- **Files:** `src/lib/db/repos/occurrences.ts`, `src/lib/db/repos/occurrences.test.ts`
- **Pattern:** none in-repo — this establishes the directory `AGENTS.md` has always specified.
  Query style lifted from `profile.ts:121-136`.
- **Build:** `listForDay`, `listOverdue`, `listAll`, `create`, `update`, `remove`. **Every function
  takes claims and opens its own `withUser()`** — the repo is the only module that imports Drizzle
  for this table. The overdue SQL predicate lives here and nowhere else.
- **Output:** the sole Drizzle caller for `task_occurrence`.
- **Check:** unit tests with a mocked tx assert the shape of each query, including that `remove`
  carries a `where` on both `id` and `user_id`.

**3 · Pure task predicates** `[parallel with 2, after 1]`
- **Files:** `src/lib/tasks/{overdue,progress,status}.ts` + their `.test.ts`
- **Pattern:** `src/lib/profile-form.ts` — pure exported functions, exported message constants, no
  JSX, no imports from `db`.
- **Build:** `isOverdue({ deadlineAt, status }, now)`, `TASK_STATUSES` + labels + `nextStatus()`,
  `clampProgress`/`isValidProgress`, and the shared `taskInput` Zod schema (title 1..200, notes
  ≤2000, `progress_pct` `int().min(0).max(100)`).
- **Output:** the single definition of overdue for all UI code.
- **Check:** `isOverdue` returns **false for a null deadline however old** (criterion 8), true for
  past + `todo`/`in_progress`, false for past + `done` (criterion 10), false once the deadline moves
  future (criterion 11). Progress accepts 0 and 100, rejects −1 and 101 (criterion 12).

**4 · User-timezone day boundary** `[parallel with 2, 3, after 1]`
- **Files:** `src/lib/time/{user-tz,day-boundary}.ts` + `.test.ts`
- **Pattern:** the `Intl` handling in `src/lib/profile-form.ts` — note `Intl.supportedValuesOf`
  omits `"UTC"`, already solved there; reuse `isKnownTimeZone`.
- **Build:** `todayInZone(tz, now)` → `YYYY-MM-DD`; `dayRangeInZone(tz, isoDate)` → the UTC instants
  bounding that local day. Pure, `now` injected — never reads the ambient clock.
- **Output:** the one way any code decides what "today" means.
- **Check:** `Asia/Manila` at 22:00 local resolves to that local date while the server sits in UTC on
  the next day (criteria 18/19); a UTC-midnight boundary lands on the right side in both directions;
  a zone with a half-hour offset (`Asia/Kolkata`) is correct.

### Wave 2

**5 · Dialog, Textarea and the form controls** `[after 1]` — parallel-safe with 2, 3, 4
- **Files:** `src/components/ui/{dialog,textarea}.tsx`, `src/components/ui/primitives.test.tsx`
  (extend), `src/app/globals.css` (backdrop only)
- **Pattern:** `src/components/ui/tabs.tsx` for the hand-rolled component shape; `input.tsx` for
  token-driven styling.
- **Build:** `Dialog` wrapping the **native `<dialog>`** — `showModal()`/`close()` driven by an
  `open` prop via ref, `onClose` wired to the element's own `close` event so Escape and the close
  button take the same path. `Textarea` mirroring `Input`'s token styling.
- **Critical:** style `::backdrop` with an **explicit colour**, not `var(--token)`. Tokens declared
  only in `@theme inline` are never emitted as real CSS variables, so `var()` outside a utility
  resolves to nothing and the backdrop silently renders transparent.
- **Output:** an accessible modal with zero new dependencies.
- **Check:** a Vitest render mounts both; Escape fires `onClose`; the dialog is not in the
  accessibility tree when closed.

### Wave 3

**6 · The task tRPC router** `[after 2, 3]`
- **Files:** `src/lib/trpc/routers/task.ts`, `src/lib/trpc/routers/task.test.ts`,
  `src/lib/trpc/routers/_app.ts` (register)
- **Pattern:** `profile.ts` end to end — named Zod input export, `toPublicTask()` projection because
  the link has **no transformer**, `withUser()` per call.
- **Build:** `list`, `listForDay`, `listOverdue`, `create`, `update`, `remove` — **all
  `activeProcedure`**. Every one delegates to the repo; none imports Drizzle. `update` returning no
  row is `NOT_FOUND`, exactly as `profile.update` does.
- **Output:** a typed router registered on `AppRouter`.
- **Check:** `createCallerFactory` unit tests — anonymous on `list` throws `UNAUTHORIZED`, a
  `pending` profile throws `FORBIDDEN`, `progress_pct: 101` throws `BAD_REQUEST` at the Zod boundary
  before any query runs.

### Wave 4 — tasks 7 and 8 are parallel-safe (disjoint files)

**7 · Task list, row, card and edit dialog** `[after 5, 6]`
- **Files:** `src/components/tasks/{task-list,task-row,task-card,task-dialog,status-control,
  progress-control,task-empty,task-skeleton}.tsx` + tests
- **Pattern:** `settings-screen.tsx` for the client-component + `trpc.useMutation` + `utils`
  invalidation shape; `TableRowsSkeleton` from `skeleton.tsx`.
- **Build:** `<Table>` at `md`+ and a **stacked `md:hidden` card list** below it — both with their
  own loading and empty states. Status is a native `<select>`; progress is
  `<input type="range" step="1">` with a live readout. Buttons tied to an in-flight mutation use the
  `Button` `loading` prop.
- **Critical:** no sections inside cards; design tokens only, no raw hex.
- **Output:** the full one-off task CRUD surface.
- **Check:** Testing Library — editing a title calls `update` once with the right payload; a `done`
  task rendered at 40% keeps **both** (criterion 12); the card list renders below `md` and the table
  above it.

**8 · The three pages** `[after 5, 6]`
- **Files:** `src/app/(app)/today/page.tsx` (replace the placeholder), `src/app/(app)/tasks/page.tsx`,
  `src/app/(app)/overdue/page.tsx`, `src/components/dashboard/nav-config.tsx`,
  `src/components/dashboard/nav.test.tsx`
- **Pattern:** `(app)/layout.tsx:39-40` — a server component calling `buildContext(supabase)` for
  `profile.timezone`, then handing an ISO date string to the client child.
- **Build:** `/today` renders an **Overdue group above a Today group**; `/tasks` the full list;
  `/overdue` the derived bucket alone. Drop `comingSoon` from the Tasks and Overdue nav entries.
- **Critical:** the client must not compute the date itself (criterion 19).
- **Output:** three navigable, responsive screens.
- **Check:** `isNavItemActive` now returns true for `/tasks`; nav test updated; no horizontal scroll
  at 375px.

### Wave 5

**9 · Close criterion 6, retrofit `profiles`, prove it end to end** `[after all]`
- **Files:** `tests/integration/rls-boundary.test.ts` (extend), `tests/integration/tasks.test.ts`,
  `src/lib/db/repos/profiles.ts`, `src/lib/trpc/routers/profile.ts` (delegate to the repo),
  `e2e/tasks.spec.ts`, `AGENTS.md`
- **Pattern:** the existing two-user + admin harness; `e2e/helpers/forms.ts` for any form filling —
  **never inline `fill()`**, per the phase-1 hydration race.
- **Build:** add a `task_occurrence` describe block to the boundary spec — A sees only A's tasks, B
  cannot read A's by id, **an admin session sees zero of A's rows**, `dbAdmin` sees all. Retrofit
  `profiles` into a repo module so the convention is honoured rather than entrenched. E2E: create →
  edit → set progress → mark done → overdue appears and clears.
- **Output:** criterion 6 closed for real; `AGENTS.md` updated to record what phase 2 established.
- **Check:** `pnpm test:integration` green; `pnpm test:e2e` green; all four gates green; criteria
  6, 8, 9, 10, 11, 12, 18, 19, 23, 24 demonstrably pass.

## Verify gates

From `AGENTS.md` — not guessed:

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Plus, for this phase: `pnpm test:integration` and `pnpm test:e2e` with the local stack up
(`pnpm db:start`). E2E additionally needs the WebKit binary — `pnpm exec playwright install webkit`.

## Branch / PR target

Branch `phase-2-tasks` → **PR into `main`**.

Phase 1 merged as PR #1 (merge commit `4ce1ffe`, 2026-08-06). It was a true merge, not a squash, so
`phase-1-foundation`'s tip is an ancestor of `main` and this branch already sits on main's history —
**no rebase is needed**, and the PR diff starts cleanly at the merge base. The stacked-PR note that
stood here while #1 was open no longer applies.

**The session never merges.**

## Risks & rollbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Missing `GRANT`s make correct policies fail with *permission denied*.** Reads like a broken policy and is not one. | Medium | Task 1 copies `0003`'s grants block first, and its check asserts the failure mode explicitly. Already burned once — it is carry-forward item 1 from phase 1. |
| **The SQL and TypeScript overdue definitions drift.** Two sources of truth for the phase's central predicate. | Medium | The predicate lives only in the repo (task 2) and only in `overdue.ts` (task 3); task 4's check asserts they agree on a shared fixture set. |
| **Criterion 19 hydration flash.** Any client-side `new Date()` reintroduces it. | Medium | "Today" is computed server-side and passed as a string (task 8). The e2e in task 9 asserts no day change between SSR and hydration. |
| **`::backdrop` styled with a `var()` renders transparent.** `@theme inline` tokens are never emitted as real CSS variables. | Medium | Task 5 uses an explicit colour and its check looks at the built CSS, not the source. |
| **`series_id` with no FK lets a bad value in.** | Low | Every phase-2 write sets it to NULL; phase 3 adds the FK against data that trivially satisfies it. Accepted deliberately over shipping an unexercised table. |

**Rollback:** every task is one atomic commit on `phase-2-tasks`. Nothing is deployed, so rollback is
`git reset`. The migration is additive — `0004` can be dropped without touching `profiles`.

## Deferred to later phases

- `task_series`, the rule columns, `expand()`, the `series_id` FK and the partial unique index
  (phase 3).
- Tags, search, filters (phase 4); admin tier (phase 5); email reminders (phase 6).
- `/tasks/[id]` as a route — revisit in phase 4 if notes outgrow the dialog.
- Whether `occurs_on` is re-derived when a user changes timezone. Leaning **no** — the stored date is
  a user intention, not a computed value — but it must be said out loud before someone "fixes" it.
