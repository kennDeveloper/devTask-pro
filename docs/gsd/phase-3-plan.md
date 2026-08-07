# devtask-pro phase 3 — plan

> GSD stage 2 of 5 · [Discuss ✓] → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/phase-3-discuss.md` · Branch: `phase-3-recurrence` (worktree, own Supabase stack)
> Phase 3 of 6: **recurrence engine** · Built in parallel with phase 5

## Goal

A user writes a repeat rule once and gets a trackable occurrence on every date it names. Each
occurrence carries its own status and progress, and setting one does not disturb its neighbours.
Editing the rule moves the occurrences nobody has touched and leaves the ones they have. Deleting the
series takes the untouched future with it and leaves the recorded history standing.

The engine that decides which dates a rule names is a pure function with no clock and no database,
so criteria 13, 16 and 20 are ordinary unit tests rather than something you wait until October to
observe.

## Research findings (verified in the code and against the running stack, not assumed)

1. **`0004_task_occurrence.sql` already wrote this migration's brief.** Lines 100–105 name the two
   statements phase 3 owes — the FK with `on delete cascade` and
   `unique (series_id, occurs_on) where series_id is not null` — and lines 166–202 explain the
   default-privilege hole and revoke it. Because `0004` killed the default, `task_series` starts with
   a clean ACL and needs only its own `grant`, not a `revoke` first. That is a real difference from
   `0004`, and the migration says so rather than copying a revoke that would now be noise.

2. **`interval` is safe as a bare column name on this Postgres.** Probed on the worktree stack:
   `create table t (interval int, check (interval between 1 and 366))` succeeds and the constraint
   bites (`new row ... violates check constraint "t_interval_check"`). Postgres parses `INTERVAL`
   as a type constructor only when a literal follows. So the brief's sketch spelling is kept, and
   no reader has to wonder why it was renamed.

3. **Drizzle 0.45.2 supports the partial-index upsert.** `onConflictDoUpdate` takes `targetWhere`
   (`node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts:65`), which is what lets one
   statement target `unique (series_id, occurs_on) where series_id is not null`. Materialising is
   therefore a single round trip and cannot lose a race to itself. `time` and `text[]` column types
   are both present.

4. **`localInputToInstant` in `src/components/tasks/task-presentation.ts:243` is already the
   wall-clock → instant conversion criterion 20 needs**, including the resolve-the-offset-twice
   trick. It is in the wrong place for `src/lib/**` to reuse — a lib importing a component
   directory points the dependency arrow backwards. The conversion moves to
   `src/lib/time/day-boundary.ts` as `instantFromWallClock()`, and both `localInputToInstant` and
   `startOfDayInZone` delegate. `startOfDayInZone` keeps its extra "verify the candidate lands on
   the requested date" step, which is right for midnight and deliberately wrong for a user-typed
   time (see its own comment).

5. **`isOverdue` (`src/lib/tasks/overdue.ts:49`) already accepts a structural shape**
   (`{ deadlineAt: Date | string | null; status }`), so a virtual occurrence satisfies it with no
   change. `overdueCondition` stays the SQL half for materialised rows. The two halves keep their
   phase-2 contract; nothing about overdue is re-decided here.

6. **`toPublicTask` (`src/lib/trpc/routers/task.ts:62`) already emits `seriesId`.** The wire type
   the components consume therefore already distinguishes a recurring occurrence from a one-off —
   only the `virtual` flag is new.

7. **Both list presentations are always mounted** (`task-list.tsx:287,335`), which is why the e2e
   rule is "select by role" and why `task-row.tsx` and `task-card.tsx` must name controls
   identically. Any control this phase adds has to be added to **both**, with the same accessible
   name, or the mobile project silently loses coverage.

8. **`task.list` is unpaginated by design** and `occurrences.ts:174` flags recurrence as the moment
   that stops being safe. That is the constraint behind open item 1's answer below.

9. **The phase-2 e2e seeds a task at `dayFromToday(-400)` and asserts it is visible on `/tasks`**
   (`e2e/tasks.spec.ts:262`). Any windowing applied to *materialised* rows would break that spec —
   which is the evidence for windowing only the virtual side.

10. **`tests/integration/rls-boundary.test.ts` ends at line 419** with the `task_occurrence` block.
    Phase 5 is editing the same file, so the `task_series` block is **appended** and nothing above
    it is touched or reformatted.

11. **The e2e helper `seedTask` writes through `serviceClient()`** and `createAccount` leaves the
    profile at the schema-default `UTC` timezone, so `dayFromToday()` is the app's idea of today.
    A series seeded for e2e must use the same assumption.

## The four open items, resolved

### 1 · How far ahead does a list view expand, and where is the cap enforced?

**Two different limits, doing two different jobs.**

- **The window is chosen at the read boundary**, in `src/lib/tasks/feed.ts`, from the server-resolved
  clock: `/today` expands exactly one day, `/overdue` expands `[today − 30, today]` (a future
  occurrence cannot be late), `/tasks` expands `[today − 30, today + 60]`. Never in a component —
  the window is derived from `currentUserClock()`'s day, which is criterion 19 applied to a range
  instead of a point.
- **The cap is enforced inside `expand()`**, as `MAX_OCCURRENCES_PER_EXPANSION = 366`. It is a
  property of the pure function — *this function returns at most 366 dates and always terminates* —
  not a policy the caller can forget. 366 is a year of a daily rule: comfortably above the 91-day
  window so the window is what binds in normal use, and low enough that a runaway rule allocates
  nothing interesting.

**Only virtual occurrences are windowed. Materialised rows are read exactly as phase 2 read them.**
That is what keeps the −400-day task on `/tasks` (finding 9) and it is the honest split: a row
exists because a person acted on it and should not disappear because it aged out of a range, while a
virtual occurrence is a projection and a projection needs bounds.

Back 30 days, because a month is the most missed recurring work anyone wants nagging them, and it
guarantees at least one occurrence of a monthly series is in view. Forward 60 days, because the list
is unpaginated (finding 8) and a quarter of a daily series is already 90 rows.

### 2 · Does editing a rule re-materialise, or just re-expand?

**Just re-expand. A rule edit writes nothing and deletes nothing.**

- Untouched occurrences were never rows, so the new rule simply produces different dates on the next
  read. Nothing to delete.
- Touched occurrences are rows, and criterion 15 says they keep their status and progress. So a row
  on a date the new rule no longer produces **survives and is still listed** — it is a real record of
  real work on a real day. The read path is therefore a *union* keyed on `occurs_on`
  (materialised wins), not a filter of virtual dates.
- **Materialised ⇒ touched**, by definition, and the definition is about history rather than current
  values. A user who sets an occurrence to `in_progress` and back to `todo` keeps the row; deleting
  it when the values return to their defaults would make "untouched" depend on a snapshot instead of
  on whether anybody ever acted, which is the fragile version of the same idea.
- Series *content* edits (title, notes, deadline time) follow the same rule: untouched occurrences
  pick them up automatically because they are rendered from the series, and materialised rows keep
  their snapshot. This is the brief's own precedent — "editing series tags affects future untouched
  occurrences only".

### 3 · Where does the repeat-rule editor live?

**Its own `SeriesDialog`, not an extension of `TaskDialog`.**

The two forms have almost nothing in common once you look. A series has no status, no progress and
no deadline *instant* — it has a rule and a deadline *time of day*. A one-off has all three and no
rule. Merging them means roughly half the controls are inert at any moment and the two most-used
controls in the app (`Status`, `Progress`) become meaningless for the thing being edited, because
each occurrence carries its own. They also call different mutations and validate against different
schemas.

Keeping them apart additionally leaves `task-dialog.tsx` untouched, so every phase-2 e2e step
through that dialog keeps passing unchanged.

Reached from **one new control, present in both presentations under the same accessible name**:
a small button rendered beside the title of any occurrence with a `seriesId`, labelled `Repeats` and
named `Repeat rule of <title>`. It is simultaneously criterion 13's "repeat affordance" and the way
into the editor, which is one control to add to `task-row.tsx` and `task-card.tsx` rather than two.
Creation is a second button beside "New task" on the lists that offer creation.

### 4 · Does `occurs_on` carry a time?

**No. `occurs_on` stays a bare `date`; the series carries `deadline_time time`, and `deadline_at` is
computed as (date + time) resolved in the account holder's zone at read time.**

This is the whole of criterion 20. Because the offset is resolved *at that instant* rather than
taken as a constant, 09:00 on 2026-03-07 in `America/New_York` is `14:00Z` and 09:00 on 2026-03-09 is
`13:00Z` — 09:00 local on both sides of the transition. Storing an instant and adding a fixed
interval would drift by an hour for half the year, and storing a zoned timestamp on `occurs_on`
would reintroduce exactly the "a calendar square that moves when the process does" problem `0004`
argues against at length.

At materialisation the computed `deadline_at` is **frozen into the row**, consistent with phase 2's
"the stored date is a user intention, not a computed value". A later timezone change moves future
untouched occurrences and leaves recorded ones where they were.

## Decisions taken at plan time

- **A virtual occurrence gets a synthetic, deterministic id — `series:<uuid>:<YYYY-MM-DD>`.** It is
  a stable React key, it is obviously not a row id, and it means the list, the row, the card and the
  controls all keep the `Task` shape they already have instead of growing a nullable `id` that
  ripples into every `key=`, `data-task-id` and control id. Encoding and decoding live in one tested
  module (`src/lib/tasks/occurrence-ref.ts`); nothing parses an id in JSX.
- **The wire type gains an explicit `virtual: boolean`.** The client could infer it from the id
  prefix, but a boolean that says what it means beats a predicate over a string, and it costs one
  field.
- **Touching a virtual occurrence materialises it through the existing `task.update`.** One mutation,
  one invalidation policy, one in-flight state — `use-task-actions.ts` does not change and neither do
  the row and card control handlers. The router branches on the ref, not the UI.
- **A date the rule does not name cannot be materialised.** `task.update` on a virtual ref re-runs
  `expand()` over that single day and returns `NOT_FOUND` if the rule does not produce it. `COUNT`
  and `UNTIL` are respected because `expand()` always counts from `starts_on` regardless of the
  window it is asked for.
- **`task.remove` keeps taking a uuid only.** Deleting a virtual occurrence is "skip this one
  occurrence", which is out of v1. A virtual ref therefore fails at the Zod boundary, and the dialog
  hides Delete for anything with a `seriesId` — a materialised series occurrence is not deleted
  either, because the rule would simply produce it again on the next read and the delete would look
  broken.
- **`default_progress` is dropped from the sketch; `reminder_lead_minutes` is kept.** The brief
  explicitly sanctions the latter ("may exist as a column; nothing sends"). The former is a column
  no feature exercises and no criterion needs, and phase 2 set the precedent for not shipping those
  — the sketch says in its own header that it is "not final".
- **`ends_mode = 'after'` counts from `starts_on`, never from the window.** The expander iterates
  from the start and *collects* what falls inside the window, so occurrence #7 of a `COUNT=10`
  series is the seventh whatever range you ask about. Any implementation that counts what it emits
  gets a different answer per window, which is the subtle version of this bug.
- **RFC 5545 spelling, order-independent parsing, canonical serialisation.**
  `FREQ` · `UNTIL`/`COUNT` · `INTERVAL` · `BYDAY`/`BYMONTHDAY` · `BYSETPOS`, with `UNTIL` as a bare
  `YYYYMMDD` because `starts_on` is DATE-valued. `parse()` accepts the parts in any order so a string
  written by hand, or by the `rrule` package if it is ever adopted, still reads.
- **`WKST` is `MO` and is not stored.** RFC 5545's default, Google Calendar's default, and the only
  value the editor can produce. Serialising a constant would invite a reader to think it varies.
- **Weekly with an empty `BYDAY` means "the weekday `starts_on` falls on"**, as RFC 5545 specifies.
  The editor always sends at least one day, so this is a robustness rule rather than a UI state.
- **Invalid dates are skipped, not clamped.** `BYMONTHDAY=31` produces nothing in February and
  `FREQ=YEARLY` from a 29 February start produces nothing in a common year. That is RFC 5545, and
  clamping to "the 28th" would silently invent an occurrence the user never asked for.
- **The RLS `select` policy does not know about `deleted_at`.** Policies answer "is this yours";
  filtering soft-deleted rows is the repo's job. Mixing the two makes a policy that has to be
  re-read every time the application's idea of "visible" changes.

## Tasks

Each is sized for one fresh context window. `[seq]` must follow its predecessor; tasks sharing a
wave touch disjoint files and are parallel-safe.

### Wave 0

**1 · `0005` migration, schema mirror, the FK and the partial unique index** `[seq]` — **highest
risk in the phase**
- **Files:** `supabase/migrations/0005_task_series.sql`, `src/lib/db/schema.ts`
- **Pattern:** `0004_task_occurrence.sql` in shape — prose header, columns with reasons, indexes,
  triggers, RLS, grants last. Note the difference finding 1 records: `0004` already revoked the
  default privilege, so this table starts clean and needs no `revoke`.
- **Build:** `task_series` with the rule columns; `touch_updated_at` trigger; **all four policies**,
  `with check` on both insert and update; `grant select, insert, update, delete … to authenticated`,
  `grant all … to service_role`, nothing to `anon`. **No privileged-column guard trigger** — there
  is no privileged column, exactly as `task_occurrence`. Then
  `alter table task_occurrence add constraint task_occurrence_series_fk foreign key (series_id)
  references task_series(id) on delete cascade` and
  `create unique index task_occurrence_series_day_uniq on task_occurrence (series_id, occurs_on)
  where series_id is not null`.
- **Cross-column CHECKs, named:** monthly ⇔ `month_mode is not null`; `by_date` ⇔ `month_day`;
  `by_nth_weekday` ⇔ `nth_week` + `nth_weekday`; `ends_mode='on'` ⇔ `ends_on`; `'after'` ⇔
  `ends_count`; `'never'` ⇔ both null. `byweekday` constrained to the seven RFC 5545 codes.
- **Output:** `pnpm db:reset` applies cleanly; `schema.ts` mirrors it by hand with a comment naming
  what the SQL holds that Drizzle cannot.
- **Check:** `pnpm db:reset` exits 0; a duplicate `(series_id, occurs_on)` insert fails with 23505;
  two rows with `series_id is null` and the same `occurs_on` still insert fine (the partial index
  must not catch one-offs).

### Wave 1 — tasks 2, 3 and 4 are parallel-safe (disjoint files)

**2 · The pure recurrence engine** `[parallel]` — **this is where criteria 13, 16 and 20 live**
- **Files:** `src/lib/recurrence/{types,serialize,parse,expand}.ts` + `.test.ts` for each
- **Pattern:** `src/lib/tasks/progress.ts` — pure exported functions, exported constants, no clock,
  no imports from `db`.
- **Build:** `RecurrenceRule` and the weekday/frequency constants in `types.ts`;
  `serialize(rule, startsOn)` → an RFC 5545 `RRULE` value; `parse(text)` → `RecurrenceRule | null`,
  order-independent; `expand(rule, startsOn, window, limit?)` → ascending `YYYY-MM-DD[]`.
  Calendar arithmetic through `Date.UTC` as an arithmetic vehicle only — no zone enters this file.
- **Check:** `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` over 12 weeks hits exactly the expected dates
  (criterion 1); all five end conditions (criterion 2); both monthly modes **including
  `nthWeek: -1` = last Friday**; `BYMONTHDAY=31` skips February; yearly from 29 Feb skips common
  years; `COUNT` is counted from `starts_on` and is window-independent; `expand()` never returns more
  than the cap for `FREQ=DAILY` with `ends_mode: never` over ten years; **round-trip property over
  the full option matrix** — `parse(serialize(r)) === r` for every rule the editor can produce
  (criterion 6).

**3 · Wall clock → instant, in `src/lib/time`** `[parallel]` — carries criterion 20's other half
- **Files:** `src/lib/time/day-boundary.ts` (+ its test),
  `src/components/tasks/task-presentation.ts` (delegate only)
- **Pattern:** the existing `startOfDayInZone`, whose comment already explains the twice-resolved
  offset.
- **Build:** `instantFromWallClock(timeZone, isoDate, hour, minute)` as the general form;
  `startOfDayInZone` delegates and keeps its candidate verification; `localInputToInstant` in
  `task-presentation.ts` delegates and keeps its own contract of returning `null` on a malformed
  value.
- **Check:** 09:00 on 2026-03-07 and 2026-03-09 in `America/New_York` resolve to `14:00Z` and
  `13:00Z` — 09:00 local on both sides of the spring-forward (criterion 8/20); the same for
  `Europe/London`'s March transition; `Asia/Kolkata`'s half-hour offset is right; every existing
  `day-boundary` and `task-presentation` test still passes unchanged.

**4 · Series validation and the occurrence ref** `[parallel]`
- **Files:** `src/lib/tasks/series-validators.ts`, `src/lib/tasks/occurrence-ref.ts` + `.test.ts`
- **Pattern:** `src/lib/tasks/validators.ts` — named field schemas, a `SERIES_MESSAGES` constant
  object, bounds imported rather than restated.
- **Build:** `seriesInput` / `seriesUpdateInput` mirroring every CHECK in `0005`, including the
  cross-column rules as `superRefine` so the user gets a sentence rather than a Postgres string;
  `virtualOccurrenceId()` / `parseOccurrenceRef()` / `taskRefField`.
- **Check:** monthly without a mode is rejected; `ends_mode: 'after'` without a count is rejected;
  a weekly rule with an empty `byweekday` is rejected at the boundary (the editor cannot produce
  one); a virtual ref round-trips; a uuid parses as a row ref; `series:not-a-uuid:2026-01-01` is
  rejected.

### Wave 2

**5 · The series repo and the occurrence upsert** `[after 1]`
- **Files:** `src/lib/db/repos/series.ts`, `src/lib/db/repos/occurrences.ts` (extend) + their tests
- **Pattern:** `occurrences.ts` verbatim in shape — every function takes claims, opens its own
  `withUser()`, and filters on **both** id and `user_id`. **No `dbAdmin` import**, asserted by the
  same source-level guard `occurrences.test.ts:177` already uses.
- **Build:** `listActive`, `findOwn`, `create`, `update`, `softDelete` on series (all filtering
  `deleted_at is null` except where history is wanted); `listForSeries` and `materialize` on
  occurrences, the latter a single `onConflictDoUpdate` with
  `targetWhere: sql\`series_id is not null\``.
- **Check:** unit tests over the `QueryRecorder` — `softDelete` sets `deletedAt` and filters on id
  **and** `user_id`; every read carries `deleted_at is null`; `materialize` targets the partial
  index; the no-`dbAdmin` guard passes for both files.

**6 · The feed: expand, merge, and the window** `[after 2, 3, 5]`
- **Files:** `src/lib/tasks/feed.ts` + `feed.test.ts`
- **Pattern:** none in-repo; it is the composition layer between the two repos and the pure engine,
  which is what keeps the router thin.
- **Build:** `FEED_WINDOW_BACK_DAYS`/`FORWARD`, `feedWindow(today, view)`; `seriesOccurrences(series,
  window, timeZone)` — pure, builds virtual occurrences with `deadline_at` from
  `instantFromWallClock`; `mergeOccurrences(materialised, virtual)` — pure, keyed on
  `(seriesId, occursOn)`, materialised wins; `listDayFeed` / `listAllFeed` / `listOverdueFeed` /
  `materializeOccurrence`.
- **Check:** a virtual date that is also a row yields **one** entry and it is the row (criterion 3);
  a row on a date the rule no longer produces still appears (criterion 15/open item 2); a
  soft-deleted series contributes no virtual occurrences but its rows survive (criterion 5/17); an
  occurrence with no `deadline_time` is never overdue; `materializeOccurrence` refuses a date the
  rule does not name.

### Wave 3

**7 · The series router, and `task.update` learning about virtual refs** `[after 4, 6]`
- **Files:** `src/lib/trpc/routers/series.ts` + test, `src/lib/trpc/routers/task.ts` (extend) +
  test, `src/lib/trpc/routers/_app.ts` (**one line** — shared with phase 5)
- **Pattern:** `task.ts` end to end — named Zod inputs, a `toPublicSeries()` projection because the
  link has no transformer, `activeProcedure` on every procedure.
- **Build:** `series.list`, `series.get`, `series.create`, `series.update`, `series.remove`;
  `task.list`/`listForDay`/`listOverdue` delegate to `feed.ts`; `task.update` branches on the ref.
- **Check:** `createCallerFactory` units — anonymous is `UNAUTHORIZED`, `pending` is `FORBIDDEN`,
  a malformed rule is `BAD_REQUEST` before any query, one user's series id is `NOT_FOUND` for
  another (criterion 11), and `series.ts` imports no `dbAdmin` (criterion 12, same source guard).

### Wave 4 — tasks 8 and 9 are parallel-safe (disjoint files)

**8 · The repeat-rule editor and the repeat affordance** `[after 7]`
- **Files:** `src/components/tasks/{series-dialog,series-form,weekday-picker,repeat-button}.tsx`
  and `series-form.ts`, plus edits to `task-row.tsx`, `task-card.tsx`, `task-list.tsx`,
  `task-dialog.tsx` + tests
- **Pattern:** `task-dialog.tsx` + `task-form.ts` — the dialog holds values in state, a pure builder
  module decides what to send, the schemas are imported not restated.
- **Build:** frequency, interval, weekday picker, monthly `by_date` vs `by_nth_weekday`, the three
  end conditions; `RepeatButton` rendered in **both** row and card as `Repeat rule of <title>`;
  `TaskDialog` hides Delete when `task.seriesId` is set; a "New repeating task" button beside
  "New task".
- **Critical:** row and card must name the new control identically (finding 7); design tokens only;
  no sections inside cards — the weekday picker is a `<fieldset>` inside a dialog, not a nested box
  inside a `Card`.
- **Check:** Testing Library — switching frequency to Monthly reveals the mode control and hides the
  weekday picker; submitting builds the expected rule payload; a recurring row and a one-off row
  differ only by the repeat button; both presentations expose the same accessible names.

**9 · Nav and pages** `[after 7]` — parallel-safe with 8
- **Files:** `src/app/(app)/tasks/page.tsx` (copy only),
  `src/components/dashboard/nav-config.tsx` (**shared with phase 5 — smallest possible edit**)
- **Build:** nothing structural. The three pages already pass `clock` down and the feed arrives
  through the same procedures, so recurrence appears on `/today`, `/tasks` and `/overdue` with no
  new route. Only the `/tasks` description sentence changes to stop claiming the list is only what
  you "wrote down".
- **Check:** no new route to gate, screenshot or add to the proxy's allow list.

### Wave 5

**10 · Prove it — RLS block, integration, e2e** `[after all]`
- **Files:** `tests/integration/rls-boundary.test.ts` (**append a block; do not restructure** —
  phase 5 is editing it), `tests/integration/series.test.ts`, `e2e/helpers/tasks.ts` (extend),
  `e2e/series.spec.ts`
- **Build:** a `task_series` describe block mirroring the `task_occurrence` one — A sees only A's,
  B cannot read A's by id, **an admin session sees zero rows** (criterion 10), `dbAdmin` sees all,
  cross-owner insert/update/delete are refused, and the table cannot be TRUNCATEd by
  `authenticated`. A separate integration spec proves the **partial unique index actually rejects a
  duplicate `(series_id, occurs_on)`** (criterion 7) and that two one-offs on the same day still
  insert. E2E: create a weekly series through the dialog, see one row per occurrence, set the third
  to `in_progress` at 60%, reload, assert #1/#2/#4 untouched (criterion 3), edit the rule and assert
  the touched one kept both (criterion 4), delete the series and assert the touched row survives
  while the untouched ones are gone (criterion 5).
- **Check:** `pnpm test:integration` green; `pnpm test:e2e` green; all four gates green.

## Verify gates

From `AGENTS.md` — not guessed:

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Plus, for this phase — data access is touched, so both are mandatory:

```
pnpm test:integration
pnpm test:e2e
```

Both need this worktree's stack and its env:

```bash
cd .../devtask-pro-worktrees/phase-3-recurrence
set -a; . ./.env.worktree; set +a      # API 54431 · DB 54432 · next dev 3001
```

## Branch / PR target

Branch `phase-3-recurrence` → **PR into `main`**, opened by a human. The session stops after Verify.

Built in a worktree beside phase 5. `supabase/config.toml` is locally modified so its ports come
from `env(...)`; **that edit is never staged**. Files phase 5 also touches are limited to one line in
`src/lib/trpc/routers/_app.ts` and (if needed) `src/components/dashboard/nav-config.tsx`, and the
`rls-boundary` block is appended rather than woven in.

## Risks & rollbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The partial unique index catches one-off tasks.** `where series_id is not null` is the only thing stopping every one-off on the same day colliding — and `''` vs `NULL` is a known way to fall into a partial index by accident. | Medium | Task 1's check inserts two one-offs on the same day explicitly. `series_id` is a `uuid`, which has no empty-string spelling, so the classic version of this trap cannot arise — but it is asserted rather than reasoned about. |
| **`COUNT` counted per-window instead of from `starts_on`.** Occurrence #7 would be a different date depending on which page you were looking at. | Medium | `expand()` always iterates from `starts_on`; task 2's check asserts the same date for `COUNT=10` under three different windows. |
| **A rule edit destroys recorded work.** The single worst outcome in the phase — criterion 15 exists because of it. | Medium | Rule edits write nothing and delete nothing (open item 2). The read path is a union, not a filter, and task 6's check asserts an orphaned row still appears. |
| **DST drift on a recurring deadline.** A fixed offset is right for ten months of the year, which is exactly why it survives review. | Medium | `instantFromWallClock` resolves the offset at the instant; task 3's check pins both sides of a spring-forward. |
| **An unbounded expansion.** `ends_mode: never` is genuinely infinite. | Low | The cap lives inside the pure function, so no caller can omit it, and it is asserted over a ten-year window. |
| **The new control lands in the row but not the card** (or under a different name), silently halving e2e coverage. | Medium | Task 8's check asserts identical accessible names in both presentations, and the e2e selects by role so the `mobile` project exercises the card copy. |
| **A merge conflict with phase 5.** | Low | Three touch points, each one line or an append. |

**Rollback:** every task is one atomic commit. Nothing is deployed. `0005` is additive — dropping it
restores phase 2's schema, since the FK and the index are the only changes to an existing table and
both are `add constraint` / `create index`.

## Deferred to later phases

- Tags on a series (`series_tags`) and filtering — **phase 4**. `task_series` ships so the FK is
  available; no tag surface is built.
- Admin tier — **phase 5**, in parallel.
- `reminder_lead_minutes` is a column and nothing reads it — **phase 6**.
- `EXDATE`/`RDATE`, "skip this one occurrence", per-occurrence rule edits, `BYSETPOS` beyond
  nth-weekday-of-month — out of v1 entirely.
- **Pagination of `/tasks`.** Phase 2 flagged the cursor as due when recurrence starts generating
  rows; the window (open item 1) buys time rather than solving it, and this is the note that says so
  out loud.
- Adopting the `rrule` package. The stored string is RFC 5545-valid, so the swap stays additive.
