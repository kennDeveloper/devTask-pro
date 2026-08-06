# devtask-pro phase 2 — discuss

> GSD stage 1 of 5 · **Discuss** → Plan → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md` · Branch: `phase-2-tasks` (stacked on `phase-1-foundation`)
> Phase 2 of 6: **one-off tasks + overdue** · Mode: interactive

## Request

The first real data feature. A user creates one-off tasks with an optional deadline, moves them
`todo → in_progress → done`, sets a progress percentage by hand, and sees anything past its deadline
in a derived **Overdue** bucket. This is also where the phase-1 access guarantee stops being a
demonstration on `profiles` and becomes the real thing on a real task table.

## In scope

- **`task_occurrence` table** — the trackable unit. A one-off task is an occurrence with
  `series_id = NULL`, per the brief's one-read-path decision.
- RLS policies and explicit `GRANT`s for it; `dbAdmin` never touches it.
- **Create / edit / delete** a one-off task: title, notes, date, optional deadline, status,
  progress.
- **`/today`** — an Overdue group above a Today group.
- **`/tasks`** — the full list with an edit dialog.
- **`/overdue`** — the derived bucket on its own.
- Status control and progress control, editable inline on a row.
- Pure predicates for overdue / status / progress, and the user-timezone day boundary.
- Closing **criterion 6** by re-pointing `tests/integration/rls-boundary.test.ts` at
  `task_occurrence`.

## Out of scope

- **Recurrence of any kind** — `task_series`, the rule columns, `expand()`, the FK and the partial
  unique index are all phase 3. `series_id` exists as a nullable column with no FK.
- Tags, search, filters (phase 4). Admin tier (phase 5). Email reminders (phase 6).
- `/tasks/[id]` as a route — editing is a dialog this phase.
- Bulk actions, drag-to-reorder, keyboard shortcuts, undo.
- Subtasks, attachments, comments — out of v1 entirely.

## Acceptance criteria

Numbers in brackets map to `devtask-pro-v1.md`; unnumbered ones are phase-2 specific.

**Tasks**
1. **[8]** A one-off task with no deadline is never overdue, however old `occurs_on` gets.
2. **[9]** A task with `deadline_at < now` and status ≠ `done` appears in Overdue **and** still
   shows its underlying `todo`/`in_progress` status in the UI.
3. **[10]** Marking an overdue task `done` removes it from Overdue immediately — no job, no refetch
   of a stored flag.
4. **[11]** Editing an overdue task's deadline into the future removes it from Overdue immediately.
5. **[12]** Progress accepts 0 and 100 inclusive, rejects −1 and 101 at the Zod boundary, and is
   **fully independent of status** — a `done` task may sit at 40% and must not be coerced to 100.
6. Creating a task with no date given defaults `occurs_on` to **today in the user's timezone**, not
   the server's.
7. The overdue SQL predicate and the pure `isOverdue()` helper agree on a shared fixture set — one
   definition of overdue, asserted in both directions.

**Access**
8. **[6]** An admin's session reading `task_occurrence` returns **zero rows** — asserted in
   `tests/integration/rls-boundary.test.ts`, not in the UI. Role does not defeat RLS.
9. User B cannot read, update or delete user A's task through any tRPC procedure.
10. `dbAdmin` is not imported by any task read or write path.

**Timezone**
11. **[18]** For a user in `Asia/Manila`, a task due 23:00 local is not overdue at 22:00 local,
    whatever the server's timezone.
12. **[19]** The `/today` boundary is midnight in the user's timezone on **both SSR and client** —
    no hydration flash showing a different day.

**Presentation**
13. The list renders as a `<Table>` at `md` and above and as a **stacked card list** below it, each
    with its own loading and empty states.
14. Loading states are skeletons mirroring the real layout — resolving causes no layout shift.
15. **[23]** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
16. **[24]** Playwright screenshots every route, both themes, mobile and desktop, no console errors.

## Decisions

- **`occurs_on date NOT NULL`, defaulting to today in the user's timezone** — every task belongs to
  a day the user can move. Keeps `/today` a single query for one-offs and, later, recurrences; a
  nullable variant would split the read path in two, which the brief explicitly set out to avoid.
- **`deadline_at timestamptz NULL`, separate from `occurs_on`** — "the day I plan to do it" and "the
  moment it is late" are different facts. Because it is `timestamptz`, `deadline_at < now()` is an
  absolute comparison, so criterion 18 falls out of the type rather than needing timezone maths.
- **`/today` shows an Overdue group above a Today group** — a daily tracker that hides stale work on
  its main screen fails its core job. `/overdue` still exists as its own route; appearing in both is
  intended, not duplication.
- **Overdue is derived, never stored** — `deadline_at < now() AND status <> 'done'`. A NULL deadline
  yields NULL, therefore false, which is criterion 8 for free. Criteria 10 and 11 are then automatic
  rather than requiring invalidation logic.
- **`task_series` is deferred to phase 3** — phase 2 ships `series_id uuid NULL` with **no** FK and
  no partial unique index. Every row is NULL, so phase 3 can add the table, the constraint and the
  index against data that trivially satisfies them. Nothing is built that no feature exercises.
- **Editing is a dialog over the list, not a `/tasks/[id]` route** — one surface to build, gate,
  screenshot and test. Status and progress stay inline on the row for quick changes. The route stays
  available for phase 4 if notes outgrow a modal.
- **Establish `src/lib/db/repos/` and retrofit `profiles` into it.** `AGENTS.md` mandates one repo
  module per table with routes never calling Drizzle directly, but phase 1 never created the
  directory — `src/lib/trpc/routers/profile.ts` queries Drizzle inline. Phase 2 introduces the first
  real data table, so it is the moment to honour the convention rather than entrench the drift.
  `profiles` is two queries; retrofitting it is cheap now and only gets dearer.
- **The user's "today" is computed server-side and passed down** — the server resolves the date from
  `profiles.timezone` and hands it to the client as a prop. The client must never call `new Date()`
  to decide which day it is; that is precisely what produces the criterion-19 hydration flash.

## Constraints

- **The access model is the thing that must not break.** All task reads and writes go through
  `withUser()`. `dbAdmin` bypasses RLS and has no legitimate caller in this phase.
- **Every new table needs explicit `GRANT`s in its own migration** — without them, correct policies
  fail with *permission denied* rather than returning zero rows, which reads like a broken policy
  and is not one. Follow `0003`.
- **Migrations are hand-written and numbered** (`0004_…`). Not `drizzle-kit generate` output.
  `src/lib/db/schema.ts` is the typed mirror, updated by hand.
- **Design tokens only** — no raw hex in `src/components/**` or `src/app/**`, no gradients, no heavy
  shadows. Hairline `line` borders do the structural work.
- **No sections inside cards.** A card holds one flat piece of content — split into sibling cards.
- **Lists on mobile are cards, never tables**, and both presentations need their own loading and
  empty states.
- Business logic in `src/lib/**`, never inline in a component or route handler. Predicates are pure
  exported functions so they can be unit-tested.
- `activeProcedure` is the floor for every task procedure — a `pending`, `rejected` or `suspended`
  user is authenticated but must not reach application data.
- Next.js 16 is newer than most training data — read `node_modules/next/dist/docs/` before writing
  framework code.

## Likely files

```
supabase/migrations/0004_task_occurrence.sql   table + RLS + GRANTs + indexes
src/lib/db/schema.ts                           typed mirror, by hand
src/lib/db/repos/occurrences.ts                new — the only Drizzle caller for tasks
src/lib/db/repos/profiles.ts                   retrofit, removes the phase-1 drift
src/lib/tasks/{overdue,progress,status}.ts     pure predicates + tests
src/lib/time/{user-tz,day-boundary}.ts         "today" in the user's zone, SSR-safe
src/lib/trpc/routers/task.ts                   activeProcedure, Zod at the boundary
src/app/(app)/today/page.tsx                   overdue group + today group
src/app/(app)/tasks/page.tsx                   list + edit dialog
src/app/(app)/overdue/page.tsx                 the derived bucket
src/components/tasks/…                         row, card, dialog, status + progress controls
src/components/dashboard/nav-config.tsx        un-disable Tasks and Overdue
tests/integration/rls-boundary.test.ts         re-point at task_occurrence — closes criterion 6
e2e/tasks.spec.ts                              the CRUD + overdue journey
```

## Open items for Plan

1. **Progress control shape** — slider, stepped select (0/25/50/75/100), or a number input. Affects
   the mobile card layout and how criterion 5 is asserted in the UI.
2. **Does `/today` include tasks whose `occurs_on` is in the past but which are *not* overdue** (no
   deadline, still `todo`)? They would otherwise be invisible without visiting `/tasks`. Leaning
   yes, folded into the Overdue group under a clearer name — Plan decides.
3. **Delete semantics** — hard delete, or the `deleted_at` the brief sketches on `task_series`?
   Phase 3 needs soft delete for series history (criterion 17); deciding it now avoids a second
   migration.
4. **Whether `occurs_on` should be re-derived** when a user changes their timezone in settings.
   Leaning no — the stored date is a user intention, not a computed value — but it needs saying out
   loud before someone "fixes" it later.
