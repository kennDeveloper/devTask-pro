# devtask-pro phase 4 — discuss

> GSD stage 1 of 5 · **Discuss** → Plan → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md`, `docs/gsd/phase-3-plan.md` · Branch: `phase-4-tags`
> Phase 4 of 6: **tags + search/filter**
> **Stacked on `phase-3-recurrence`**, which is verified but not merged. See "Branch model".

## Request

Make a list of tasks findable. Three things, which are one thing: user-defined **tags** with a
manager and a filter; **search** by title; and **filters** by status and date range. Tags attach to
both a one-off occurrence and a series — the series' tags being a *template* that is copied onto an
occurrence when it materialises, exactly as its title and deadline already are.

## In scope

- **`tags` table** — `name`, `color`, unique per user case-insensitively. RLS + explicit `GRANT`s.
- **`series_tags` and `occurrence_tags`** — the two join tables, each carrying `user_id` so RLS
  scopes them the same way as every other table.
- **Tag manager** — create, rename, recolour, delete. Deleting a tag detaches it everywhere.
- **A tag picker** on the task dialog and the series dialog.
- **Tags copied onto an occurrence at materialisation**, per the v1 decision.
- **Search by title**, and filters by **status** and **date range**, on `/tasks`.
- **Filter by tag**, working on projected occurrences as well as materialised rows.
- Tag chips on the row and the card, named identically in both.
- An `rls-boundary` block for all three tables, per `AGENTS.md`.

## Out of scope

- Admin tier — **phase 5**, on its own branch. Nothing under `src/app/(admin)/**`.
- Email reminders and `reminder_log` — **phase 6**.
- Saved searches, smart lists, boolean tag queries (`A AND NOT B`), tag hierarchies, shared or
  suggested tags. One flat per-user list, filtered by any-of.
- Full-text search, ranking, stemming, fuzzy matching. See the decision below.
- Bulk tagging, drag-to-tag, colour pickers beyond a fixed palette.
- Sorting controls. The list keeps its existing order.

## Acceptance criteria

None of v1's numbered criteria cover this phase, so these are phase-specific — as phase 2's were.

**Tags**
1. A tag name is unique per user **case-insensitively**: creating "Work" when "work" exists is
   rejected at the Zod boundary and by a unique index, and the index is asserted, not assumed.
2. Two different users may each own a tag called "work".
3. Deleting a tag removes it from every task and series that carried it, and deletes no task.
4. Renaming a tag is reflected everywhere it appears, with no write to `task_occurrence`.

**Attachment**
5. Tagging a **series** does not write to `task_occurrence`. The tags appear on its projected
   occurrences because they are read from the series.
6. Materialising an occurrence copies the series' tags onto it at that moment; later changes to the
   series' tags do not alter it.
7. Tagging a single occurrence of a series leaves its siblings untouched.

**Search and filter**
8. Search matches on title, case-insensitively, on **both** materialised rows and projected
   occurrences — a recurring task is never invisible to a search that should find it.
9. Status, date-range and tag filters likewise apply to both halves, and compose (all filters are
   AND-ed; multiple tags are OR-ed within the tag filter).
10. Clearing every filter returns exactly the unfiltered list.
11. A filter that matches nothing renders the empty state, not a spinner.

**Access**
12. An admin's session reading `tags`, `series_tags` or `occurrence_tags` returns **zero rows**,
    asserted in `tests/integration/rls-boundary.test.ts` — new blocks, appended.
13. A user cannot attach **their** tag to **another user's** task, and cannot attach another user's
    tag to their own — enforced by the database, not by a `.where()`.
14. `dbAdmin` is not imported by any tag read or write path.

**Presentation**
15. Tag chips appear on the row and the card under the same accessible names, per the e2e rule.
16. The filter bar collapses sensibly at 375px and the list keeps its table/card split.
17. `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
18. Playwright screenshots every route without error, mobile and desktop.

## Decisions

- **Composite foreign keys carry ownership into the join tables.** `occurrence_tags` references
  `task_occurrence (id, user_id)` and `tags (id, user_id)` on **both** columns at once. A foreign
  key check does not consult RLS, so a plain two-column-two-FK design would let a signed-in user
  create a link row between their own tag and somebody else's task — leaking nothing readable, but
  writing into another account's data. The composite FK makes "the link, the tag and the task all
  belong to the same person" a thing the database cannot be talked out of. It needs a
  `unique (id, user_id)` on both parents, which is cheap.
- **`user_id` on the join tables**, per the v1 sketch ("both join tables all carry
  `USING (user_id = auth.uid())`"). The alternative — a policy with an `EXISTS` subquery against the
  parent — is a policy that reads another table on every row, and is the shape that eventually
  recurses.
- **Search is `ILIKE '%term%'`, not full-text.** A personal task list is bounded by one human's own
  history; `tsvector`, a stemming configuration and a GIN index would be real machinery serving a
  query that will never see ten thousand rows, and it would *change the semantics* — full-text does
  not match mid-word, which is exactly what someone typing three letters expects. Revisit if a list
  ever gets slow; the predicate lives in one place so the swap is local.
- **Every filter is evaluated on both halves of the feed.** Materialised rows are filtered in SQL,
  projections in memory, from one shared definition — the same split `isOverdue` and
  `overdueCondition` already have, and `AGENTS.md` already requires those two to change together.
  The alternative, filtering only rows, would make a recurring task silently invisible to search,
  which is worse than not shipping the filter.
- **Tag filtering is "any of", not "all of".** Picking Work and Urgent shows tasks carrying either.
  It is what every tool with this control does, and "all of" is expressible later without changing
  the stored shape.
- **A fixed palette of named colours, stored as a token name and not a hex.** `AGENTS.md` forbids
  raw hex under `src/components/**` and `src/app/**`; a free colour picker would put one in the
  database instead, where the dark theme could not adjust it.
- **Deleting a tag is a hard delete, cascading the link rows.** There is no history to preserve —
  a tag is a label, not a record of work — and a soft-deleted tag would need filtering out of every
  join for the rest of the project's life.

## Constraints

- **The access model is the thing that must not break.** All tag reads and writes go through
  `withUser()`. `dbAdmin` has no legitimate caller in this phase.
- **Every new table needs explicit `GRANT`s in its own migration.** Three tables here, so three
  grant blocks. Follow `0003`/`0004`/`0005`.
- **All four policies per table, with a `WITH CHECK` on both `insert` and `update`.**
- **The SQL is authoritative**; `src/lib/db/schema.ts` is a typed mirror updated by hand.
- `activeProcedure` is the floor for every tag procedure. Validate every input with Zod.
- Business logic in `src/lib/**`. Predicates and validators are pure exported functions.
- Design tokens only; no raw hex, no gradients. No sections inside cards.
- **e2e: never a bare `fill()` or `selectOption()`** — go through `fillForm`/`selectForm`. Select by
  role, never CSS or test id, and keep the row and the card naming controls identically.
- Next.js 16 is newer than most training data — read `node_modules/next/dist/docs/` first.

## Branch model

`phase-4-tags`, branched from `phase-3-recurrence` **which is verified but not yet merged**. Phase 4
needs `task_series` for its `series_tags` foreign key, so it stacks rather than waiting. Confirmed
with the user this session: everything ships together later.

Consequences to keep in view:

- **The migration is `0007`.** Phase 3 took `0005`; phase 5 reserved `0006` on its own branch off
  `main`. `0006` is therefore absent from this branch's history, which is harmless — migrations order
  lexicographically and a gap is not a hole.
- **Phase 5 is still running in parallel**, so the shared files stay off-limits or near enough:
  nothing under `src/app/(admin)/**`, `src/components/admin/**`, or `repos/profiles.ts`; the smallest
  possible edit to `src/lib/trpc/routers/_app.ts`; and `tests/integration/rls-boundary.test.ts` is
  **appended to, never restructured**.
- `supabase/config.toml` is still locally modified for this worktree's ports and must never be
  staged.

## Open items for Plan

1. **Where does the tag manager live** — a section of `/settings`, or its own route? A new route
   means touching `nav-config.tsx`, which phase 5 also owns.
2. **How does the filter state travel** — component state, or the URL query string? The URL makes a
   filtered list shareable and survives a reload, but the filters are read on the server for SSR and
   that pulls `searchParams` into three pages.
3. **Does tag *filtering* on a projected occurrence read the series' tags, or does the feed
   pre-resolve them?** Affects how many queries a filtered list costs.
4. **Does search cover the description as well as the title?** v1 says "search by title"; notes are
   where people put the detail they later look for.
