# devtask-pro phase 3 — discuss

> GSD stage 1 of 5 · **Discuss** → Plan → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md`, `docs/gsd/phase-2-discuss.md` · Branch: `phase-3-recurrence`
> Phase 3 of 6: **recurrence engine** · Mode: interactive
> Built in a dedicated worktree alongside phase 5; the two do not share files. See "Parallel build".

## Request

Recurring tasks. A `task_series` holds a Google-Calendar-style repeat rule; occurrences are
expanded from it for the window being viewed and written to `task_occurrence` on first touch. Each
occurrence carries its own independent status and progress, so editing the rule must not destroy
work already recorded against a specific date.

Phase 2 shipped `task_occurrence` with `series_id uuid NULL`, no FK, and no partial unique index —
deliberately, so this phase adds all three against data that trivially satisfies them.

## In scope

- **`task_series` table** — the rule columns from the brief's data-model sketch, plus
  `deleted_at` for the soft delete that criterion 17 needs. RLS policies and explicit `GRANT`s.
- **The FK and the partial unique index on `task_occurrence`** —
  `series_id → task_series(id)`, and `UNIQUE (series_id, occurs_on) WHERE series_id IS NOT NULL`.
- **`src/lib/recurrence/`** — a pure, dependency-free `expand()`, plus `serialize()` and `parse()`
  for the RFC 5545 `rrule` string. Heavily unit-tested; this is where criteria 13, 16 and 20 live.
- **Lazy materialization** — an occurrence row is written on first touch (any status or progress
  change). Reads expand virtually and merge over materialized rows.
- **Series CRUD** — create a recurring task, edit its rule, delete the series.
- **The repeat-rule editor UI** — frequency, interval, weekday picker, monthly `by_date` vs
  `by_nth_weekday`, and the three end conditions.
- A `rls-boundary` block for `task_series`, per `AGENTS.md`.

## Out of scope

- Tags, search, filters — **phase 4**. Note phase 4's `series_tags` will reference `task_series`;
  ship the table so that FK is available, but build no tag surface here.
- Admin tier — **phase 5**, built in parallel in its own worktree. Do not touch
  `src/app/(admin)/**`, `src/components/admin/**`, or add admin procedures.
- Email reminders and `reminder_log` — **phase 6**. `reminder_lead_minutes` may exist as a column;
  nothing sends.
- `EXDATE`/`RDATE`, "skip this one occurrence", editing a single occurrence's rule, `BYSETPOS`
  beyond nth-weekday-of-month — out of v1 entirely.
- Calendar sync of any kind. "Calendar-style" describes the rule vocabulary only.
- Adopting the `rrule` npm package. We own a small pure expander; the stored string being
  RFC 5545-valid keeps that swap additive later.

## Acceptance criteria

Numbers in brackets map to `devtask-pro-v1.md`.

**Recurrence**
1. **[13]** `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` produces occurrences on exactly the expected dates
   across a 12-week window, asserted by unit test on the pure `expand()` function.
2. **[16]** All five end conditions behave: never / on `<date>` / after `<N>` occurrences; and both
   monthly modes expand correctly, **including "last Friday"**.
3. **[14]** Setting occurrence #3 of a series to `in_progress` at 60% persists that row and leaves
   #1, #2 and #4 untouched.
4. **[15]** Editing a series' rule changes only future **untouched** occurrences; any occurrence
   already carrying status or progress keeps both.
5. **[17]** Deleting a series removes untouched future occurrences and leaves completed history
   intact.
6. `serialize()` and `parse()` round-trip every rule the editor can produce, asserted as a property
   over the full option matrix.
7. The partial unique index actually prevents a duplicate `(series_id, occurs_on)` — asserted, not
   assumed.

**Timezone**
8. **[20]** A recurring task set to 09:00 fires at 09:00 local across a DST transition, for zones
   that observe one.
9. **[19]** Nothing under `src/components/**` decides what day it is. The expansion window comes
   from the server via `currentUserClock()`.

**Access**
10. **[6]** An admin's session reading `task_series` returns **zero rows**, asserted in
    `tests/integration/rls-boundary.test.ts` — a new block, not a replacement of the existing ones.
11. User B cannot read, update or delete user A's series through any tRPC procedure.
12. `dbAdmin` is not imported by any series read or write path.

**Presentation**
13. A recurring series appears in the Tasks list as **one row per occurrence** in the viewed range —
    visually indistinguishable from a one-off except for a repeat affordance.
14. Table at `md`+ and a stacked card list below it, each with its own loading and empty states.
    Row and card name their controls identically, per the e2e rule in `AGENTS.md`.
15. **[23]** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
16. **[24]** Playwright screenshots every route without error, mobile and desktop.

## Decisions

- **Recurring series render as expanded occurrences in the list, not a collapsed series row.**
  Confirmed with the user this session. It preserves the brief's "one read path, not two" decision:
  a row is a `task_occurrence` whether or not it has a `series_id`, so the existing status and
  progress controls, the overdue predicate, and both list presentations work unchanged. A collapsed
  row would need a second read path and its own status semantics for a thing that is not a task.
- **Migration number is `0005`.** Reserved up front because phase 5 is being built in parallel and
  takes `0006`. Two files both numbered `0005` would **not** conflict in git — different filenames
  merge cleanly — and the collision would only surface as non-deterministic ordering later.
- **`deleted_at` on `task_series`, hard delete on `task_occurrence`.** Phase 2 settled hard delete
  for occurrences; criterion 17 needs series history to survive, so the soft delete lives on the
  series alone. This is the migration that adds it.
- **`expand()` is pure and takes an explicit window.** No clock read inside it, no timezone lookup —
  the caller passes the range and the zone. That is what makes criteria 13, 16 and 20 unit-testable
  without mocking time, and it keeps the function honest about criterion 19.
- **Materialize on touch, never on read.** A read expands virtually and left-joins materialized
  rows. Nothing writes during a GET, so a list view stays a pure read and rule edits only disturb
  rows nobody has touched.

## Constraints

- **The access model is the thing that must not break.** All series reads and writes go through
  `withUser()`. `dbAdmin` has no legitimate caller in this phase.
- **Every new table needs explicit `GRANT`s in its own migration.** Without them, correct policies
  fail with *permission denied* rather than returning zero rows. Follow `0003`/`0004`.
- **All four policies, and a `WITH CHECK` on both `insert` and `update`.** `USING` alone lets a
  caller create a row owned by someone else, or hand their own row away by re-pointing `user_id`.
- **Do not copy the privileged-column guard trigger** from `0003` — `task_series` has no privileged
  column, exactly like `task_occurrence`.
- **The SQL is authoritative**; `src/lib/db/schema.ts` is a typed mirror updated by hand. Never
  `drizzle-kit generate`.
- `activeProcedure` is the floor for every series procedure. Validate every input with Zod.
- Business logic in `src/lib/**`. Predicates and validators are pure exported functions.
- Design tokens only; no raw hex, no gradients, no heavy shadows. No sections inside cards.
- **e2e: never a bare `fill()`** — go through `fillForm()`. Select by role, never CSS or test id.
- Next.js 16 is newer than most training data — read `node_modules/next/dist/docs/` first.

## Parallel build

This phase is built in a git worktree at `../devtask-pro-worktrees/phase-3-recurrence`, against its
**own** Supabase stack (API 54431, DB 54432, Studio 54433, Mailpit 54434) with `next dev` on 3001.
Phase 5 runs simultaneously on 5444x / 3002. Main is untouched on 5442x / 3000.

- `supabase/config.toml` here is locally modified to read every host port from `env(...)`, sourced
  from `.env.worktree`. **That edit must never be staged** — it would break `main`'s stack. Revert
  it before the PR. Stage files explicitly; never `git add -A`.
- Files phase 5 also touches: `src/lib/trpc/routers/_app.ts` (one line each) and
  `src/components/dashboard/nav-config.tsx`. Keep edits there minimal and surgical.
- `tests/integration/rls-boundary.test.ts` — **add a block, do not restructure the file.** Phase 5
  is editing it too.

## Open items for Plan

1. **How far ahead does a list view expand?** `/today` is one day, but `/tasks` shows a range. A
   series with `ends_mode = never` is infinite, so the expander needs a hard cap. Decide the cap and
   where it is enforced — in `expand()` or at the repo boundary.
2. **Does editing a rule re-materialize, or just re-expand?** Criterion 15 says untouched
   occurrences follow the new rule. If they were never rows, nothing needs deleting — but if a
   previous edit materialized some, they may now be orphaned on dates the new rule does not produce.
3. **Where does the repeat-rule editor live** — extending the existing task dialog, or a separate
   surface? The dialog is already carrying one-off fields; adding nine rule columns may overflow it.
4. **Does `occurs_on` for an occurrence carry a time**, or does `deadline_time` on the series
   combine with the date at read time to produce `deadline_at`? Criterion 20 (DST) turns on this.
