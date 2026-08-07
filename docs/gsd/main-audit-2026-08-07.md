# devtask-pro `main` — cross-phase audit

> GSD stage 4 of 5 · Verify, run against `main` rather than a single phase branch
> Audited 2026-08-07 · Commit `1de5470` · Working tree clean
> Question asked: *does the code on `main` already satisfy the plans in `docs/gsd/`?*

## Answer

**Phases 1–5 are delivered and green. Phase 6 (reminders) does not exist yet** — no plan, no
discuss doc, no code. That accounts for the only two unmet acceptance criteria.

**22 of the 24 criteria in `devtask-pro-v1.md` hold, with evidence.** The two open ones (21, 22)
are the reminder criteria and belong entirely to the unbuilt phase.

## Gates

Every command run and its exit code read — nothing inferred.

| Gate | Result | Evidence |
|---|---|---|
| `pnpm typecheck` | **pass** | exit 0 |
| `pnpm lint` | **pass** | exit 0 |
| `pnpm test` | **pass** | exit 0 — 39 files, **1058 tests** |
| `pnpm build` | **pass** | exit 0 — 16 routes + proxy emitted |
| `pnpm test:integration` | **pass** | exit 0 — 3 files, **86 tests** (after the repair below) |
| `pnpm test:e2e` | **pass** | exit 0 — **54 tests**, chromium + iPhone 14, `--workers=2` |

## Environment defect found and fixed — not a code defect

`pnpm test:integration` failed on first run: 21 failures, all `relation "task_series" does not
exist`.

*Root cause.* The local stack was still at migration **0004**. Phases 3, 4 and 5 were built in
parallel worktrees, each with its own Supabase stack; those stacks were torn down after the merges
and `main`'s 5442x stack was never re-reset. So `0005_task_series` and `0006_tags` were merged into
the repo but had never been applied to the database the tests point at. Confirmed directly against
`supabase_migrations.schema_migrations` before touching anything — the recorded versions stopped at
0004 while six files sat on disk.

*Fix.* `pnpm db:reset` (all six applied) then `pnpm admin:create`. The database held exactly one
row worth keeping — the bootstrap admin — and `admin:create` is idempotent, so the reset cost
nothing. **No application code changed.**

*Worth knowing.* This is the standing hazard of the parallel-worktree recipe: tearing down a
worktree's stack leaves `main`'s stack behind the merged migrations, and the symptom is a wall of
integration failures that reads exactly like a broken phase. Re-reset `main`'s stack after merging
any phase that added a migration.

## Acceptance criteria

Numbering follows `docs/gsd/devtask-pro-v1.md`. Note that specs use **phase-local** criterion
numbers in their test names — `admin.spec.ts`'s "criterion 6" is the brief's criterion 7.

### Access control

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | New signup lands on `/pending`, cannot reach `(app)` | **pass** | `auth-flow.spec.ts:56`, `admin.spec.ts:134` |
| 2 | After approval, reaches `/today` with no re-signup | **pass** | `auth-flow.spec.ts:62`, `admin.spec.ts:134` |
| 3 | Rejected user sees `/no-access` | **pass** | `auth-flow.spec.ts:82`, `admin.spec.ts:176` |
| 4 | Suspension terminates a live session on the next request | **pass** | `auth-flow.spec.ts:69`, `admin.spec.ts:249` — proxy reads `profiles.status` live, so the still-valid JWT does not help |
| 5 | Non-admin gets 404 on `/admin/*`, not a rendered page | **pass** | `auth-flow.spec.ts:94`, `admin.spec.ts:113` — asserts HTTP 404 |
| 6 | Admin session reading a task table returns **zero rows** | **pass** | `rls-boundary.test.ts` — three proofs: `task_occurrence` (:234), `task_series` (:451), tags + both join tables (:1076) |
| 7 | Admin-triggered password reset sets a new password and signs in | **pass** | `admin.spec.ts:272` — full Mailpit round trip |

### Tasks

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 8 | No deadline ⇒ never overdue, however old | **pass** | `tasks.spec.ts:252`, `overdue.test.ts:23`, `feed.test.ts:423` |
| 9 | Overdue task retains its real `todo`/`in_progress` status | **pass** | `tasks.spec.ts:206,221`, `tasks.test.tsx:281` |
| 10 | Marking done clears the bucket immediately, no job | **pass** | `tasks.spec.ts:227,239`, `overdue.test.ts:47` |
| 11 | Moving the deadline forward clears it immediately | **pass** | `overdue.test.ts:57` |
| 12 | Progress 0–100 inclusive, rejected out of range, independent of status | **pass** | `progress.test.ts:19`, `validators.test.ts:205,231`, `tasks.spec.ts:151` — done at 40% keeps both facts |

### Recurrence

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 13 | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE` over 12 weeks | **pass** | `expand.test.ts:41` — unit test on the pure `expand()` |
| 14 | Touching occurrence #3 leaves #1/#2/#4 alone | **pass** | `series.spec.ts:151`, `feed.test.ts:234` |
| 15 | Rule edit moves untouched occurrences only | **pass** | `series.spec.ts:181`, `occurrences.test.ts:492`, `feed.test.ts:269` — the read path is a union, not a filter |
| 16 | Five end conditions + both monthly modes incl. "last Friday" | **pass** | `expand.test.ts:116,213,267` |
| 17 | Deleting a series clears the untouched future, keeps history | **pass** | `series.spec.ts:212`, `series.test.ts:326`, `feed.test.ts:355` |

### Timezone

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 18 | 23:00 Manila is not overdue at 22:00 local, any server tz | **pass** | `day-boundary.test.ts:61`, `overdue.test.ts:67`, `user-tz.test.ts:223` |
| 19 | "Today" boundary identical SSR and client, no hydration flash | **pass** | `currentUserClock()` is read in exactly three places, all server pages (`today`, `tasks`, `overdue`); grep confirms **no** `new Date()` / `Date.now()` / `toLocaleDateString` anywhere under `src/components/**` outside comments |
| 20 | 09:00 stays 09:00 across a DST transition | **pass** | `day-boundary.test.ts:263`, `feed.test.ts:154` — offset resolved at the instant, not reused |

### Reminders

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 21 | A reminder sends at most once, proven by running the job twice | **not built** | Phase 6. No `reminder_log` table, no `api/cron/reminders` route, no `src/lib/email/` |
| 22 | No reminder for an occurrence already `done` | **not built** | Same |

The groundwork exists and is correct: `reminder_lead_minutes` columns on both tables (`0004`,
`0005`, the latter bounded `0..10080`), and `dbAdmin`'s doc comment already names the reminder job
as a sanctioned caller. Nothing sends.

### Gates

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 23 | All four gates pass | **pass** | table above |
| 24 | Playwright screenshots every route, mobile and desktop | **pass** | `screenshots.spec.ts` — 2 themes × 2 viewports over public / gate / signed-in / admin routes, plus a no-horizontal-scroll assertion |

## Scope coverage beyond the numbered criteria

Everything in the brief's **In scope** list is built except email reminders:

- Auth: sign-up, sign-in, forgot-password, reset-password, `auth/callback` — all present.
- Search + the three filters: `filter-validators.ts` takes `search`, `statuses`, `from`/`to`,
  `tagIds`, with a backwards-range refinement. Filtering happens server-side.
- Tags: manager, picker, chips; `TagManager` is the fourth sibling card in `/settings`, exactly as
  phase 4 planned — `nav-config.tsx` untouched.
- Per-user timezone: captured at signup, editable in the Profile card, validated through
  `canonicalTimeZone()`.
- Admin tier: users list, approve/reject/suspend/reinstate, password reset, account metadata only.

## Constraints held

- **No raw hex** in `src/components/**` or `src/app/**` — grep clean.
- **No module exports a bare `db`** — grep clean.
- **`dbAdmin` confined to sanctioned callers** — `isolation.test.ts` asserts the exact importer set
  off disk with comments stripped, and passes.
- **No `tailwind.config.*`** — Tailwind v4 stays CSS-first.
- **Nothing under `src/components/**` decides what day it is** — verified by grep, criterion 19.
- Mobile: no page scrolls horizontally at iPhone 14 width — asserted in e2e.

## Gaps that are not criteria

1. **Phases 2–5 were verified; only the written `phase-N-verify.md` is missing.** Every phase ran
   its gates and recorded the output — the record just lives in the PR body instead of `docs/gsd/`:

   | Phase | PR | Gate evidence recorded | Unit | Integration | e2e |
   |---|---|---|---|---|---|
   | 1 | #1 | PR table **+ `docs/gsd/phase-1-verify.md`** | 244 / 7 files | 17 | 24 |
   | 2 | #2 | **none — body is CodeRabbit auto-notes only** | — | — | — |
   | 3 | #4 | PR table | 784 / 29 files | 63 | 34 |
   | 4 | #5 | PR table | 1058 / 39 files | 86 | 54 |
   | 5 | #3 | PR table | 708 / 27 files | 35 | 47 (1 known flake) |

   Phase 4's recorded numbers — 1058 unit / 39 files, 86 integration, 54 e2e — are **exactly** what
   this audit measured on `main` today. Phase 4 was the last merge, so that is a clean confirmation
   that `main` still sits at its verified state and nothing regressed across the merges.

   **Phase 2 is the only real gap.** Its PR body carries no gate table. The indirect evidence is
   good — phase 3's PR cites a "baseline 464" unit tests and "baseline 27" integration, which is
   the phase-2 state, so the suite existed and was counted — and every phase-2 criterion (8–12, 18,
   19) is re-proven green in this audit. Nothing is actually unverified; it was just never written
   down at the time.
2. **Phase 6 is unplanned, not just unbuilt** — no `phase-6-discuss.md`, no `phase-6-plan.md`.
   `gsd-discuss` is the next step, not `gsd-plan`.
3. **Deployment is still deferred** — no `vercel.json`, no cron declaration. Consistent with the
   standing decision that deployment matters but is not urgent; noted rather than skipped quietly.

## Verdict

**`main` satisfies the plans that exist.** Phases 1–5 are complete, all six gates are green with
evidence, and 22 of 24 criteria are observed to hold. The remaining two are phase 6's, and phase 6
has not been discussed or planned.
