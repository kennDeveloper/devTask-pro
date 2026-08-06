# devtask-pro phase 1 — verify

> GSD stage 4 of 5 · [Discuss ✓] → [Plan ✓] → [Execute ✓] → **Verify** → Ship
> Input: `docs/gsd/phase-1-plan.md` · Verified 2026-08-06 · Mode: autonomous

Session resumed mid-phase: tasks 1–7 were already committed, tasks 8 and 9 were complete in the
working tree but uncommitted and had never been verified.

## Gates

Commands from `AGENTS.md`. Every one run and its exit code read — nothing inferred.

| Gate | Result | Evidence |
|---|---|---|
| `pnpm typecheck` | **pass** | exit 0 |
| `pnpm lint` | **pass** | exit 0 |
| `pnpm test` | **pass** | exit 0 — 7 files, **244 tests** |
| `pnpm build` | **pass** | exit 0 — 13 routes, proxy emitted |
| `pnpm test:integration` | **pass** | exit 0 — 2 files, **17 tests** (the RLS boundary) |
| `pnpm test:e2e` | **pass** | exit 0 — **24 tests**, chromium + iPhone 14, after the fix below |

Local stack up throughout (`supabase status`: API 54421, Studio 54423, Mailpit 54424).

## Defect found and fixed during verify

**`criterion 3 — a rejected account sees /no-access` failed on WebKit, 3 runs out of 3.** Not a
flake — deterministic, and it would have failed the same way in CI.

*Root cause.* The failure snapshot showed the email input **empty and `[invalid]`** with the form's
own "Enter your email address." alert, while the password input still held its value. `/sign-in`
calls `useSearchParams`, so its form sits behind a `Suspense` boundary and hydrates late. Playwright
filled the email into the pre-hydration DOM, where React had no listener attached; the first
controlled render then reset the field to `""`. The password was filled a beat later, after
hydration, so it survived. The form submitted with an empty email and stopped on validation — which
reads exactly like a broken redirect, and is not one. WebKit hydrates slowly enough to lose that
race every time; Chromium usually wins it.

*Fix.* `e2e/helpers/forms.ts` — `fillForm()` fills a set of fields then re-reads them all, retrying
until the values survive, and `signIn()` wraps the whole sign-in interaction. Fills all fields
before asserting any, because a value can be accepted and wiped a moment later. No arbitrary sleep.

*Scope.* The same racy sequence was inlined at **five** call sites across `auth-flow.spec.ts` and
`screenshots.spec.ts`; the three in `screenshots.spec.ts` were passing by luck and were latent CI
flakes. All five now go through the helper. The previously failing test went from a 30 s timeout to
1.5 s.

*Not an app bug.* The product code is unchanged. A real user typing into a form before hydration
loses the keystroke — inherent to controlled React inputs, marginal behind `autoFocus`, and out of
phase-1 scope. Noted, not fixed.

Also installed the Playwright **WebKit** binary, which was missing (`playwright install webkit`).
The `mobile` project is `devices["iPhone 14"]`, so 8 tests were erroring on a missing executable
before any of this was reachable.

## Acceptance criteria

Numbering follows `docs/gsd/devtask-pro-v1.md`.

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | New signup lands on `/pending`, cannot reach the app | **pass** | e2e journey, both viewports |
| 2 | After approval, reaches `/today` with no re-signup | **pass** | e2e journey |
| 3 | Rejected user sees `/no-access` | **pass** | e2e (the test fixed above) |
| 4 | Suspension bites on the very next request | **pass** | e2e journey — token still valid, live `profiles.status` read catches it |
| 5 | Non-admin gets 404 on `/admin/*`, not a rendered page | **pass** | e2e asserts HTTP 404 |
| 6 | Admin session reading a task table returns zero rows | **open — by design** | No task tables until phase 2. Mechanism proven on `profiles`: an admin `withUser` session cannot see another user's row, `dbAdmin` can. Harness left in place to re-point. |
| 7 | Password reset delivers a recovery email and signs in | **partial** | User-initiated path built and unit-tested (`forgot-password`, `reset-password`). Admin-triggered is phase 5. |
| 18 | Overdue respects the user's timezone | **foundation only** | Timezone is captured, validated and round-trips (`profile-form.test.ts`, `profiles` integration test). No deadline logic exists yet, so the criterion is not demonstrable. Phase 2. |
| 19 | "Today" boundary is midnight in the user's timezone, SSR and client | **foundation only** | Same — no task list to bound. Phase 2. |
| 23 | All four gates pass | **pass** | table above |
| 24 | Playwright screenshots every route, mobile and desktop | **pass** | 2 themes × 2 viewports, plus a no-horizontal-scroll assertion |

**Correction to the plan.** `phase-1-plan.md` task 9 claimed criteria 18 and 19 would "demonstrably
pass" this phase. They cannot: both are statements about task deadlines and the today list, and
neither exists until phase 2. Phase 1 lays their precondition only. Recorded here rather than
ticked, so phase 2 does not inherit them as already-proven.

## Constraints held

- **No raw hex** in `src/components/**` or `src/app/**` — grep clean.
- **No module exports a bare `db`** — grep clean.
- **`dbAdmin` is not reached from user-facing paths.** It appears in `src/proxy.ts` and
  `src/lib/trpc/server.ts` **only inside comments explaining why not to use it there**. The proxy
  reads `profiles` through the request-scoped client; `buildContext` reads through `withUser`.
- **No `tailwind.config.*`** — Tailwind v4 stays CSS-first.
- Mobile: no page scrolls horizontally at iPhone 14 width (asserted in e2e).

## Verdict

**Phase 1 is verified.** Every gate green with evidence, every phase-1 criterion observed to hold,
criteria 6/18/19 recorded as open with reasons rather than silently ticked.

## Shipped

**PR: <https://github.com/kennDeveloper/devTask-pro/pull/1>** — `phase-1-foundation` → `main`,
10 commits, open and unmerged. Gates re-run green as a Ship pre-flight immediately before the push,
not trusted from the run above.

The repository was empty at ship time, so `main` was created at the scaffold commit `aa7cc10` to
give the PR a real base. That leaves the scaffold on `main` un-reviewed — worth a glance before
merge, because nothing downstream will review it.

`gh` lives in a per-account config dir on this machine: `usegitlightningventures` exports
`GH_CONFIG_DIR="$HOME/.config/gh-lightningventures"`. Without it `gh auth status` reads the default
`~/.config/gh`, which does not exist, and reports "not logged into any GitHub hosts" on an account
that is in fact authenticated.

## Carry-forward to phase 2

1. Re-point `tests/integration/rls-boundary.test.ts` at `task_occurrence` and close **criterion 6**
   there. The two-user + admin harness already exists; only the table changes.
2. **Criteria 18 and 19 are still open** — they need deadline logic and the today list, which phase
   2 introduces. Do not treat them as inherited.
3. `pnpm test:e2e` needs the **WebKit** binary (`pnpm exec playwright install webkit`); the `mobile`
   project is `devices["iPhone 14"]`. CI will need that step too.
4. New auth-adjacent forms should fill via `e2e/helpers/forms.ts`, not inline `fill()` calls — see
   the hydration race above.
