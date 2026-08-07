# devtask-pro phase 6 — verify

> GSD stage 4 of 5 · Discuss → Plan → Execute → **Verify** → Ship
> Input: `docs/gsd/phase-6-discuss.md`, `docs/gsd/phase-6-plan.md` · Branch: `phase-6-reminders`
> Verified 2026-08-07 · 15 commits on the branch · Working tree clean

## Answer

**All six gates pass and 17 of the 18 acceptance criteria hold as written.** Criterion 12 holds in
substance and is recorded below as **partial**, because one clause of it turned out to be wrong: a
test file did need adding to the sanctioned-`dbAdmin` set, though no application module did.

The brief's two open criteria from the 2026-08-07 audit — **21** and **22** — are closed, each with
three independent proofs (unit, integration, e2e).

## Gates

Every command run and its exit code read.

| Gate | Result | Evidence |
|---|---|---|
| `pnpm typecheck` | **pass** | exit 0 |
| `pnpm lint` | **pass** | exit 0 |
| `pnpm test` | **pass** | exit 0 — 45 files, **1163 tests** (was 39 / 1058) |
| `pnpm build` | **pass** | exit 0 — **17 routes** + proxy (was 16); `/api/cron/reminders` emitted `ƒ` (dynamic) |
| `pnpm test:integration` | **pass** | exit 0 — 4 files, **111 tests** (was 3 / 86) |
| `pnpm test:e2e` | **pass** | exit 0 — **62 tests** (was 54), chromium + iPhone 14 |

No flakes: the reminder e2e was run twice (alone, then in the full suite) and passed both times on
both projects.

## Acceptance criteria

Numbering follows `docs/gsd/phase-6-discuss.md`. Bracketed numbers map to `devtask-pro-v1.md`.

### The two open criteria

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | **[21]** Sends **at most once**, proven by running the job twice | **pass** | `reminders.test.ts:174` (one-off and series, ledger + Mailpit both exactly one), `e2e/reminders.spec.ts:121` through the real endpoint, `repos/reminders.test.ts` on the claim mechanism |
| 2 | **[22]** No reminder for an occurrence already `done` | **pass** | `reminders.test.ts:234` — both a stored row and one materialised as done; `e2e/reminders.spec.ts:173`; `due.test.ts` on the predicate |

### Identity and the no-materialisation guarantee

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 3 | Running the job leaves `task_occurrence` **byte-identical** | **pass** | `reminders.test.ts:272` — full row snapshot including `updated_at`, with a touched row present so it is not trivially empty on both sides, and `sent === 1` asserted so the run really did work |
| 4 | **[15]** still holds after a run | **pass** | `reminders.test.ts:296` — remind, then edit the rule so the reminded Wednesday is unnamed; day is empty and no rows behind it |
| 5 | **[17]** still holds after a run | **pass** | `reminders.test.ts:328` — remind, then soft-delete; day empty, no rows |
| 6 | Reminded → then materialised → no second send | **pass** | `reminders.test.ts:212`; `due.test.ts` asserts the token is identical either side of materialisation |

### Sending

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 7 | Only while the deadline is ahead; the skip is observable | **pass** | `reminders.test.ts:342` (`skippedLate === 1`, nothing sent); `due.test.ts` covers both bounds to the millisecond |
| 8 | No deadline and no lead never remind | **pass** | `reminders.test.ts:365,371` |
| 9 | 09:00 + 30 min across a DST boundary | **pass** | `due.test.ts:260,271,281` — 00:30Z year-round in Manila; 13:30Z then 12:30Z either side of the US spring-forward, resolved through `occurrenceDeadline` rather than a derived instant |
| 10 | Only `status = 'active'` accounts receive mail | **pass** | `reminders.test.ts:377`; `profiles.test.ts` asserts the `where` clause |
| 11 | 401 without the correct `CRON_SECRET`, no work done | **pass** | `e2e/reminders.spec.ts:163` (no header and wrong secret); confirmed by hand against a production server during execution |

### The access model

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 12 | No unscoped task read; `SANCTIONED_IMPORTERS` needs **no new entry** | **partial — see below** | The substance holds; one clause of the criterion was wrong |
| 13 | **[6]** An admin session reading `reminder_log` returns **zero rows** | **pass** | `rls-boundary.test.ts:1408` |
| 14 | One user cannot read or write another's ledger rows | **pass** | `rls-boundary.test.ts:1425,1436` |

**On criterion 12.** Two claims were bundled into one criterion, and they came apart:

- **Holds:** the job performs no unscoped read of any task table. It escalates once, through
  `profiles.listActiveRecipientsAsAdmin()` inside the pre-existing fence, and reads every task
  through `withUser({ sub })`. Verified by grep — the `dbAdmin` importers under `src/` are exactly
  `rls.ts`, `repos/profiles.ts` and `repos/profiles.test.ts`, **the same three as before this
  phase**. `run.ts` carries source-level tests asserting it imports neither `dbAdmin` nor any
  occurrence/series repo.
- **Wrong as written:** "`isolation.test.ts` … passes unchanged". It failed, which is the guard
  working. `tests/integration/reminders.test.ts` imports `dbAdmin`, on the same sanction phase 3's
  `series.test.ts` already has plus one of its own — criterion 3 above asks whether the job wrote
  *anything*, and a scoped read cannot tell "wrote nothing" from "wrote something I cannot see". It
  also has to set `profiles.status` to `active`, which 0003's escalation guard refuses through a
  session by design. Added with that reason recorded in the file, not waived.

The criterion should have said "no entry under `src/**`". That is what was verified.

### Presentation

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 15 | Control on both dialogs, defaults to no reminder, disabled without a deadline | **pass** | `e2e/reminders.spec.ts:54` asserts disabled-then-enabled, persistence of `30`, and persistence of `none`; `task-form.test.ts` and `series-form.test.ts` on the seeding and the payload |
| 16 | Accessible names stable; design tokens only | **pass** | e2e selects entirely by role and passes on both projects; grep finds no raw hex under `src/components/**` or `src/app/**` |

### Gates

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 17 | **[23]** All four gates pass | **pass** | table above |
| 18 | **[24]** Playwright screenshots every route, mobile and desktop | **pass** | `screenshots.spec.ts` — 2 themes × 2 viewports, plus the no-horizontal-scroll assertion, all green |

## Constraints held

Checked, not assumed.

- **No raw hex** in `src/components/**` or `src/app/**` — grep clean.
- **No module exports a bare `db`** — grep clean.
- **`dbAdmin` under `src/` is the same three files as before the phase** — grep clean.
- **No `tailwind.config.*`** — none exists.
- **Nothing under `src/components/**` decides what day it is** — the only three matches for
  `new Date()` / `Date.now()` / `toLocaleDateString` are inside doc comments explaining why such a
  call would be wrong there.
- **`reminder_log` is append-only** — `authenticated` holds exactly `SELECT` and `INSERT`, asserted
  at the privilege level in `rls-boundary.test.ts:1464`; `anon` holds nothing.
- **A new user-data table got a boundary block** — appended, not restructured.
- **e2e selects by role, never CSS or test id**; no bare `fill()` — `fillForm()` throughout.

## Worth knowing

1. **`isolation.test.ts` failing is the guard working.** It caught the new integration spec's
   `dbAdmin` import mid-phase. Recorded in `AGENTS.md` so the next person reads it as a decision
   point rather than a broken test.
2. **A `config.toml` change needs a stack restart, not a `db:reset`.** Exposing the Mailpit SMTP
   port (54425) is how phase 6's mail is delivered locally; without `supabase stop && pnpm db:start`
   nodemailer fails with `ECONNREFUSED`, which reads as a code bug. Recorded in `AGENTS.md`.
3. **`Field` renders an optional label as "Reminder · optional".** An anchored `/^reminder$/i`
   matches nothing — it cost two e2e failures that read as a missing control. Every other spec in
   the suite happens to target required fields, which is why this was the first place it bit.

## Deferred, deliberately

- **The cron cadence versus Vercel's Hobby plan.** `vercel.json` declares a five-minute schedule,
  which the 15-minute preset floor is sized against; Hobby caps cron at one invocation per day,
  which would leave only the "1 day before" preset meaningful. Deployment is deferred project-wide,
  so this is settled at deploy time. Recorded in the route handler's doc comment, since JSON has no
  comments.
- **The reminder email links to `/tasks`, not to the occurrence.** A projected occurrence has no
  route of its own, and `/tasks` does not read search params — its filters are client state — so
  `?from=&to=` would be a link that silently filters nothing. Making the filters URL-driven is a
  real feature for its own change. Recorded in `run.ts` where somebody will hit it.
- **`runReminders` reuses `listAllFeed`**, which loads tags and unwindowed rows the job does not
  need. Accepted for correctness: a narrower query would be a second definition of "what tasks does
  this person have". If volume ever justifies it, the fix is a reminder-candidate query in `feed.ts`
  — **not** a `dbAdmin` scan.

## Verdict

**Phase 6 is complete and green.** With criteria 21 and 22 closed, **all 24 criteria in
`devtask-pro-v1.md` now hold**, which completes the v1 milestone.

## Shipped

- **PR:** <https://github.com/kennDeveloper/devTask-pro/pull/6> — *Phase 6 — email reminders*
- **Branch:** `phase-6-reminders` → `main`, open and **not merged**. The merge is a human's.
- **Ship pre-flight:** all four gates re-run immediately before pushing, each exit 0. A late
  `AGENTS.md` edit (recording the new environment variables) was followed by another typecheck and
  lint, both exit 0.
- **Diff reviewed:** 50 files, +4966/−22. No `.env` file is tracked — `.gitignore` covers `.env*`,
  which is why the four new variables are documented in `AGENTS.md` rather than in a committed
  `.env.example`. No secrets, no debug code, no stray files.

### Follow-ups for the next iteration

1. **Settle the cron cadence at deploy time.** Hobby's one-run-per-day cap would leave only the
   "1 day before" preset meaningful.
2. **Deep-link the reminder email**, which needs `/tasks` to read its filters from the URL.
3. **`repos/tags.ts` names a `tags.test.ts` that does not exist** — its header claims a source-level
   `dbAdmin` guard lives there. Unrelated to this phase and deliberately not fixed here; the guard
   is worth actually writing.
