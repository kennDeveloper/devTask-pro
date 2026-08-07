# devtask-pro phase 4 — plan

> GSD stage 2 of 5 · [Discuss ✓] → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/phase-4-discuss.md` · Branch: `phase-4-tags` (stacked on `phase-3-recurrence`)
> Phase 4 of 6: **tags + search/filter**

## Goal

A task list you can find things in. Tags that belong to a person, attach to a one-off or a series,
and survive the trip onto a materialised occurrence; a search box and three filters that work on
**both** the rows in the database and the occurrences a rule is only projecting — because a filter
that quietly hides recurring work is worse than no filter.

## Research findings (verified in the code, not assumed)

1. **`/settings` is already a stack of sibling `Card`s** (`settings-screen.tsx:88,108,121` — Profile,
   Account, Appearance). A Tags card is the fourth, which is exactly the shape `AGENTS.md` asks for
   ("no sections inside cards — split into sibling cards") and means **`nav-config.tsx` is never
   touched**. That removes one of the two files phase 5 also owns from this phase's surface
   entirely.
2. **`feed.ts` already loads every live series** (`listActive`) on all three reads. Resolving a
   projection's tags therefore costs **one** extra query for the whole page, not one per
   occurrence — the series' tags are fetched once and joined in memory.
3. **The overdue predicate is already the precedent for a two-sided rule.** `overdueCondition` (SQL)
   and `isOverdue` (TypeScript) are one definition in two languages, and `AGENTS.md` requires them
   to change together. Filters take the same shape, which means the pattern is established rather
   than invented — and the same rule applies to it.
4. **`toPublicTask` is already the single serialiser for both halves** (phase 3 made it take a
   `ListedOccurrence`). Adding `tags` to it puts them on rows and projections at once, with no
   union type on the client.
5. **`task.list` takes `nowInput.optional()`** — phase 3 widened it. Filters extend that input
   rather than adding a procedure, so `TaskListLayout` keeps one query per view.
6. **`Badge` is token-driven and has six tones** (`badge.tsx` — `default`/`neutral`/`success`/
   `warning`/`danger`/`info`). A tag colour is therefore a **tone name**, not a hex, and the dark
   theme keeps working for free.
7. **`0005` is the template for a table with a composite-FK parent.** `task_occurrence` already has
   `unique (series_id, occurs_on) where series_id is not null`; adding `unique (id, user_id)` to it
   and to `task_series` and `tags` is the same kind of statement and costs one index each.
8. **`tests/integration/rls-boundary.test.ts` now ends at the phase-3 blocks.** Phase 5 is still
   editing it, so phase 4 appends three more describes and touches nothing above them.

## The four open items, resolved

### 1 · Where does the tag manager live?

**A "Tags" card on `/settings`**, beside Profile, Account and Appearance.

Its own route would need a nav entry, and `nav-config.tsx` is one of the two files phase 5 also
owns — a merge conflict bought for a screen that is a list of a dozen short strings. A card is also
the honest size: managing tags is something you do rarely and briefly, unlike the task list you open
every morning.

### 2 · How does the filter state travel?

**Client component state, sent to the server as query input.** Not the URL.

The URL would make a filtered list shareable and reload-proof, which is genuinely nicer — but the
filters would then have to be read during SSR, which pulls `searchParams` (a Promise in Next 16)
into `/tasks`, and the value would have to agree with what the client re-renders. That is the same
class of server/client disagreement the `TaskClock` arrangement exists to prevent, bought for a
feature (a shareable filtered link) that v1 does not ask for. Saved searches are explicitly out of
scope, so nothing downstream depends on the choice.

The filtering itself still happens **on the server** — the client sends the criteria, not a
predicate.

### 3 · Do projections read the series' tags, or does the feed pre-resolve them?

**The feed pre-resolves them, in one query per page.**

`listActive` already returns every live series (finding 2), so one `tagsForSeries(seriesIds)` call
returns every template tag on the page. Building a `Map<seriesId, Tag[]>` and handing each
projection its slice makes tags a plain field on `ListedOccurrence`, which means the filter, the
row, the card and `toPublicTask` all treat a projection and a row identically — no branch anywhere
above the feed.

Occurrence rows get theirs from a second query over the row ids. **Two queries for the whole list**,
regardless of how many occurrences are on it.

### 4 · Does search cover the description?

**No — title only, matching v1 exactly.**

v1's in-scope list says "Search by title + filter by status and date range", and `AGENTS.md` is
explicit that re-deciding what that document settled wastes the discussion that produced it. It is
also the more predictable behaviour: a note is often long, and a three-letter search that starts
matching prose returns things whose relevance the user cannot see from the row.

It is deliberately a one-line change (`or(ilike(title), ilike(description))` plus the same in the
pure predicate) if it is ever wanted, and the predicate lives in one place so it stays that way.

## Decisions taken at plan time

- **Composite FKs, and the `unique (id, user_id)` they need.** `occurrence_tags` references
  `task_occurrence (id, user_id)` **and** `tags (id, user_id)`. A FK check does not consult RLS, so
  without this a user could link their own tag to somebody else's task. This is the phase's one
  genuinely security-relevant piece of schema and it is what criterion 13 asserts.
- **A tag's colour is a `Badge` tone name**, constrained by a CHECK to the six that exist. No hex in
  the database, so no hex reaching `src/components/**`.
- **Filters are one value object, defined once**, with a SQL half in `repos/occurrences.ts` and a
  pure half in `src/lib/tasks/filters.ts` — the shape `overdueCondition`/`isOverdue` already
  established. A shared fixture set asserts the two agree, exactly as phase 2 did for overdue.
- **An empty filter set is not a filter.** `buildFilters` returns `undefined` for "nothing selected"
  so the unfiltered query is byte-identical to the one phase 3 shipped, and criterion 10 is
  structural rather than something to test for drift.
- **Materialisation copies tags inside the same transaction as the occurrence upsert.** Two
  statements, one `withUser` — otherwise an occurrence can exist for a moment carrying none of its
  series' tags, and a filtered list would blink it out of view.
- **Deleting a tag cascades the link rows** (`on delete cascade` on both join tables). Criterion 3's
  "and deletes no task" is then a property of the schema rather than of a repo function.

## Tasks

Each is sized for one fresh context window. `[seq]` must follow its predecessor.

### Wave 0

**1 · `0007` migration, schema mirror** `[seq]` — **highest risk in the phase**
- **Files:** `supabase/migrations/0007_tags.sql`, `src/lib/db/schema.ts`
- **Build:** `unique (id, user_id)` on `task_series` and `task_occurrence`; `tags` (name, color,
  `unique (user_id, lower(name))`); `series_tags` and `occurrence_tags` with composite FKs and
  `on delete cascade`. All four policies and a grant block **per table**. `touch_updated_at` on
  `tags`.
- **Check:** `pnpm db:reset` exits 0; "Work" and "work" collide for one user and not across two;
  a cross-owner link row is refused by the FK; deleting a tag removes its links and no task.

### Wave 1 — parallel-safe

**2 · Tag validators and the colour vocabulary** `[after 1]`
- **Files:** `src/lib/tasks/tag-validators.ts` + test
- **Build:** `TAG_COLORS` derived from `Badge`'s tones, `tagInput`/`tagUpdateInput`, name trimmed and
  length-bounded, `normaliseTagName` for the case-insensitive comparison the index enforces.

**3 · Filters, both halves** `[after 1]`
- **Files:** `src/lib/tasks/filters.ts` + test
- **Build:** `TaskFilters` (`search`, `statuses`, `from`, `to`, `tagIds`), `matchesFilters()` (pure),
  `hasAnyFilter()`, and `filterCondition()` for SQL living in `repos/occurrences.ts`.
- **Check:** the SQL and the pure predicate agree on a shared fixture set; an empty filter set is
  `undefined`; tags are OR-ed within, AND-ed across.

### Wave 2

**4 · The tags repo and the join reads** `[after 1]`
- **Files:** `src/lib/db/repos/tags.ts` + test; `repos/occurrences.ts` (extend)
- **Build:** `list`, `create`, `update`, `remove`, `setForOccurrence`, `setForSeries`,
  `tagsForOccurrences`, `tagsForSeries`. Every function opens its own `withUser()`; no `dbAdmin`,
  asserted by the same source-level guard.

**5 · The feed learns about tags and filters** `[after 3, 4]`
- **Files:** `src/lib/tasks/feed.ts` + test
- **Build:** two tag queries per read, a `Map` per side, `tags` on `ListedOccurrence`, filters
  applied to projections in memory and passed to the repo for rows. `materializeOccurrence` copies
  the series' tags.

### Wave 3

**6 · The tag router, and filter inputs on the task router** `[after 2, 5]`
- **Files:** `src/lib/trpc/routers/tag.ts` + test, `routers/task.ts`, `routers/series.ts`,
  `routers/_app.ts` (**one line** — shared with phase 5)
- **Build:** `tag.list/create/update/remove`, all `activeProcedure`; `tagIds` on the task and series
  mutation inputs; `filters` on the three list queries.

### Wave 4 — parallel-safe

**7 · Tag manager, picker and chips** `[after 6]`
- **Files:** `src/components/tags/{tag-manager,tag-picker,tag-chips}.tsx` + tests; `task-dialog.tsx`,
  `series-dialog.tsx`, `task-row.tsx`, `task-card.tsx`, `settings-screen.tsx`
- **Critical:** the chip list must name itself identically in row and card, per the e2e rule.

**8 · The filter bar** `[after 6]`
- **Files:** `src/components/tasks/task-filters.tsx` + test, `task-list.tsx`
- **Build:** search box (debounced), status multi-select, two date inputs, tag multi-select, and a
  Clear control. Collapses to a single column below `md`.

### Wave 5

**9 · Prove it** `[after all]`
- **Files:** `tests/integration/rls-boundary.test.ts` (**append three blocks**),
  `tests/integration/tags.test.ts`, `e2e/tags.spec.ts`, `e2e/helpers/tasks.ts`
- **Build:** admin-sees-zero for all three tables; the cross-owner link refusal; the
  case-insensitive unique index; tag copy-on-materialise; and an e2e journey that tags a task,
  filters to it, searches for it, and clears.

## Verify gates

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Plus `pnpm test:integration` and `pnpm test:e2e`, both against this worktree's stack:

```bash
set -a; . ./.env.worktree; set +a      # API 54431 · DB 54432 · next dev 3001 · Mailpit 54434
```

Start `pnpm dev` yourself and wait for a 200 before `test:e2e` — Playwright's `reuseExistingServer`
races a previous run's shutdown otherwise, which is what cost phase 3 a full-suite run.

## Risks & rollbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **A cross-owner tag link.** FK checks bypass RLS, so the obvious two-FK design is quietly wrong. | Medium | Composite FKs (task 1), asserted in the boundary spec (task 9). |
| **The SQL and pure filter predicates drift**, so a search shows different results depending on whether a task is a row or a projection. | Medium | One definition in `filters.ts`, two renderings; a shared fixture set asserts they agree. |
| **Tags make the list N+1.** | Medium | Two queries per read regardless of list length (open item 3), asserted by counting repo calls in `feed.test.ts`. |
| **A filtered list hides recurring work.** The failure is silent — the user simply does not find the thing. | High | Every filter is applied to both halves; the e2e journey filters to a *recurring* occurrence specifically. |
| **Merge friction with phase 5.** | Low | `nav-config.tsx` untouched; `_app.ts` one line; the boundary spec appended. |

**Rollback:** every task is one atomic commit. `0007` is additive — dropping it restores phase 3's
schema, since the only changes to existing tables are two `unique` indexes.

## Deferred to later phases

- Admin tier (phase 5, parallel); reminders and `reminder_log` (phase 6).
- Searching descriptions — deliberate, and one line (open item 4).
- Full-text search, boolean tag queries, saved searches, tag hierarchies.
- URL-encoded filter state, and the shareable filtered link it would buy (open item 2).
