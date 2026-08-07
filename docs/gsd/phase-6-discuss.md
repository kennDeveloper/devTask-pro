# devtask-pro phase 6 — discuss

> GSD stage 1 of 5 · **Discuss** → Plan → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md`, `docs/gsd/main-audit-2026-08-07.md` · Branch: `phase-6-reminders`
> Phase 6 of 6: **email reminders** · Mode: interactive
> Built on `main` in the main checkout — no parallel phase remains, so no worktree and no
> `supabase/config.toml` port surgery. Main's stack (5442x) is at migration 0006 and reset.

## Request

Email a user ahead of a task's deadline. A reminder fires once and only once, never for a task
already marked `done`, and lands at the right local hour for the account holder. This closes
acceptance criteria **21** and **22** in `devtask-pro-v1.md` — the only two of the twenty-four that
the 2026-08-07 audit found unmet.

## What is already on the ground

Read before planning; the phase is smaller than the v1 sketch implies in one place and much larger
in another.

- **`task_series.reminder_lead_minutes`** exists (`0005`, `check … between 0 and 10080`).
- **`task_occurrence.reminder_lead_minutes` does not exist.** The audit doc says both tables carry
  it; only the series table does. `0007` adds the occurrence column.
- **Nothing reads or writes either.** No validator, no repo field, no form control, no UI. The one
  column that exists is declared and inert.
- **`occurrenceDeadline(series, occursOn, timeZone)`** (`src/lib/tasks/feed.ts:184`) already resolves
  a series' wall-clock `deadline_time` to an instant *per date* in the account holder's zone. That is
  acceptance criterion 20, already green — the reminder job must use it rather than re-deriving.
- **Mailpit helpers exist and are worktree-aware** (`e2e/helpers/mailpit.ts`), built for phase 1's
  signup confirmation and phase 5's password reset. `clearInbox`, `latestFor`, `linkFromMessage`.
- **`withUser()` needs only `{ sub }`** (`src/lib/db/rls.ts:68`) — not a real JWT. A background job
  can therefore run *inside* RLS rather than around it. This is load-bearing for the design below.
- **`NEXT_PUBLIC_SITE_URL`** is already the convention for absolute links
  (`src/lib/supabase/admin.ts:107`, `src/lib/auth/redirect.ts:21`).

## The v1 decision this phase amends

`devtask-pro-v1.md:143` decided *"the reminder job materializes occurrences inside its horizon."*
**Phase 3 shipped criteria 15 and 17 on the opposite premise and they are green.**

`src/lib/db/repos/series.ts:209` states the mechanism outright: untouched future occurrences vanish
on a rule edit or a series delete *"because a deleted series is not expanded and they were never
rows."* There is no untouched-row cleanup anywhere, because until now nothing but a user's own touch
could create a row. `mergeOccurrences` is a union with rows winning, deliberately (`feed.ts:272`).

A job that materialized untouched upcoming occurrences would therefore:

- leave rows on dates a later rule edit no longer names — they would still appear, because the read
  path unions rather than filters. **Criterion 15 fails** (`series.spec.ts:181`).
- survive `softDelete`, which only tombstones the series and deliberately writes nothing to
  `task_occurrence`. **Criterion 17 fails** (`series.spec.ts:212`).

Per `AGENTS.md`, the decision changes in the doc rather than being routed around in code.
**Amendment: the reminder job never writes `task_occurrence`.** `devtask-pro-v1.md` lines 143 and the
`reminder_log` line of the data sketch are superseded by the reminder-identity decision below.

## In scope

- **Migration `0007`** — `reminder_log`, plus `task_occurrence.reminder_lead_minutes`. Explicit
  `GRANT`s and RLS policies in the same migration, per `AGENTS.md`.
- **`src/lib/reminders/**`** — the pure half: which occurrences are due to remind, given a clock, a
  window, and a set of already-sent keys. Heavily unit-tested, no I/O.
- **`src/lib/db/repos/reminders.ts`** — the `reminder_log` repo, claims-scoped like every other.
- **`src/lib/email/{send,templates}.ts`** — one SMTP transport behind one module, so the provider is
  swappable, and a plain reminder template (text + minimal HTML).
- **`src/app/api/cron/reminders/route.ts`** — the job, bearer-guarded by `CRON_SECRET`. Parses,
  delegates, serialises. All logic lives in `src/lib/**`.
- **`vercel.json`** — the cron declaration. Deployment stays deferred; the declaration costs nothing
  and is where a reader will look for the schedule.
- **Reminder lead controls** on the task dialog and the series dialog, with preset leads. Zod
  validation at the boundary; the series value seeds a materialised occurrence like every other
  template field.
- **A `reminder_log` block in `tests/integration/rls-boundary.test.ts`** — a new table holding user
  data gets a boundary proof. Add a block; do not restructure.

## Out of scope

- **In-app or push notifications.** Email only, per v1.
- **Digest or summary email** ("here is your day"). One reminder is about one occurrence.
- **Reminders for overdue tasks.** The Overdue bucket is the app's answer to lateness; see the send
  window decision.
- **A user-visible reminder history or "resend" button.** `reminder_log` is a ledger, not a feature.
- **Unsubscribe / preference centre.** These are transactional and the user opts in per task by
  choosing a lead; "none" is the default and the off switch.
- **Retry of a failed send.** At-most-once is the criterion; see the trade-off recorded below.
- **A profile-level default lead**, and any fifth Settings card.
- **Custom lead entry** (arbitrary minutes). Presets only, though the column keeps the 0–10080 bound
  so a free-text control is additive later.
- **Reminders keyed to anything but a deadline** — no "remind me at 09:00 regardless".

## Acceptance criteria

Numbers in brackets map to `devtask-pro-v1.md`. Specs use these phase-local numbers.

**The two open criteria**

1. **[21]** A reminder for a given occurrence sends **at most once**, proven by running the job
   twice against the same fixture and asserting one row in `reminder_log` and one message in
   Mailpit.
2. **[22]** No reminder is sent for an occurrence already marked `done` — asserted for both a stored
   row and a materialised series occurrence.

**Identity and the no-materialisation guarantee**

3. Running the job leaves `task_occurrence` **byte-identical** — asserted by counting rows and
   comparing `updated_at` before and after a run over a series with due reminders.
4. **[15] still holds after a run.** Reminding on a virtual occurrence, then editing the series rule
   so that date is no longer named, leaves no row and no entry on that date.
5. **[17] still holds after a run.** Reminding on a virtual occurrence, then deleting the series,
   removes it from the feed entirely.
6. A virtual occurrence that is reminded and *then* touched by the user does not remind a second
   time — the identity is `(series_id, occurs_on)` on both sides of materialisation.

**Sending**

7. A reminder fires only while the deadline is still ahead: an occurrence whose deadline has already
   passed is skipped, not sent late, and the skip is observable in the job's summary.
8. A task with no deadline never reminds, and a task with `reminder_lead_minutes IS NULL` never
   reminds, however close its deadline.
9. For a user in `Asia/Manila` with a series at 09:00 and a 30-minute lead, the reminder fires at
   08:30 Manila across a DST boundary in a zone that observes one — resolved through
   `occurrenceDeadline()`, not a stored instant.
10. Only accounts with `status = 'active'` receive mail. A `pending`, `rejected` or `suspended`
    account is skipped even with a due reminder.
11. The job rejects a request without the correct `CRON_SECRET` bearer with 401 and does no work.

**The access model**

12. The job performs **no unscoped read of any task table.** `dbAdmin` is used only to enumerate
    accounts through a fenced `…AsAdmin` function on the profiles repo; every task read and the
    `reminder_log` write run inside `withUser()`. `src/lib/admin/isolation.test.ts`'s
    `SANCTIONED_IMPORTERS` set needs **no new entry**, and that is asserted by it still passing
    unchanged.
13. **[6]** An admin's session reading `reminder_log` returns **zero rows** — a new block in
    `tests/integration/rls-boundary.test.ts`.
14. One user cannot read or write another's `reminder_log` rows — the two-user harness, same block.

**Presentation**

15. The reminder control appears on both the task dialog and the series dialog, defaults to "no
    reminder", and is disabled with an explanation when the task has no deadline.
16. Row and card name the control identically if it surfaces in the list at all; the e2e rule in
    `AGENTS.md` applies. Design tokens only; no new card sections.

**Gates**

17. **[23]** `pnpm typecheck && pnpm lint && pnpm build && pnpm test` all pass.
18. **[24]** Playwright screenshots every route without error, mobile and desktop.

## Decisions

- **The job never materialises; `reminder_log` carries the occurrence's identity, not its row id.**
  A series occurrence is `(user_id, series_id, occurs_on)` whether or not it is a row; a one-off is
  `(user_id, occurrence_id)`. Two partial unique indexes, one per shape. Because a series
  occurrence's identity does not change when the user later touches it, criterion 6 falls out for
  free rather than needing a migration of log rows. This supersedes `devtask-pro-v1.md:143` — and it
  is the reason criteria 15 and 17 keep passing.

- **The job runs inside RLS.** It enumerates active accounts through one new `…AsAdmin` function on
  `repos/profiles.ts` (the existing fenced, reviewed section), then opens `withUser({ sub: id })` per
  account and reads through the ordinary feed. Three things follow: the reminder sees exactly what
  the user sees, no new unscoped task query exists to review, and the phase adds **zero** entries to
  the sanctioned-`dbAdmin` set. `AGENTS.md` names the reminder job as a legitimate `dbAdmin` caller;
  after this phase that stays true but narrower — profiles only, never a task table. The cost is one
  transaction per account per run, which is the right trade at this scale.

- **Claim-then-send, not send-then-log.** The job inserts the `reminder_log` row with
  `on conflict do nothing returning`, and sends only if the insert claimed it. Concurrent or
  overlapping runs cannot double-send, and criterion 21 is provable by simply running the job twice.
  **Trade-off, recorded deliberately: a send that throws after the claim is a missed reminder, not a
  retried one.** The criterion is *at most once*; at-least-once would need a retry ledger, a backoff,
  and a poison-message story, all of which are worth more than this feature. Failures are counted in
  the job's response and logged.

- **Send window is `[deadline − lead, deadline)`.** A reminder that missed its moment is skipped,
  not delivered late. "Due in 30 minutes" three days after the fact is worse than silence, and the
  task is already surfacing in the Overdue bucket, which is the app's existing answer to lateness.

- **Cron every 5 minutes; presets are none / 15 min / 30 min / 1 hour / 1 day.** The shortest lead is
  three times the cadence, so the send window always contains at least two runs and a single missed
  tick never silently drops a reminder. A 10-minute preset against a 15-minute cadence would have
  been a coin flip. **Flag for deploy:** Vercel Hobby caps cron at one invocation per day, which
  would make every preset but "1 day" meaningless. This assumes Pro or an external scheduler;
  deployment is still deferred, so it is a declaration to revisit, not a live constraint.

- **SMTP through one transport module, Mailpit locally.** Honours v1's "delivery via Resend" intent
  — Resend offers SMTP — while letting e2e assert a real reminder arrives, reusing the helpers phase
  1 and 5 already built. Requires uncommenting `smtp_port` under `[local_smtp]` in
  `supabase/config.toml`. **Unlike the worktree port edits, this one is committed**; it is a real
  change to main's stack config and belongs in the diff.

- **Lead lives on both `task_series` and `task_occurrence`**, matching every other template field's
  propagation: the series value seeds an occurrence at materialisation and then lets go of it, so
  editing a series' lead affects future untouched occurrences only. Consistent with the tags
  decision in v1 and with `copyTemplateTags`.

- **Only `status = 'active'` accounts receive mail** — the same line `activeProcedure` draws. A
  suspended account must not keep receiving email about work it cannot reach.

## Constraints

- **The SQL is authoritative.** `0007` is hand-written; `schema.ts` is a typed mirror updated by
  hand. Never `drizzle-kit generate`.
- **`reminder_log` is a new table**, so: explicit `GRANT`s in the same migration (without them,
  correct policies fail with *permission denied*, which reads like a broken policy and is not one);
  RLS enabled; all four policies with `WITH CHECK` on insert and update, or a written reason why not.
  **Do not** copy the privileged-column trigger from `0003` — this table has no privileged column,
  same as `task_occurrence`.
- **A new table holding user data gets a `rls-boundary.test.ts` block.** The two-user-plus-admin
  harness is built; add a block, do not restructure the file.
- **Nothing under `src/components/**` may decide what day it is.** `currentUserClock()` is the single
  clock read. The job runs server-side and takes its instant explicitly so the pure functions are
  testable without mocking time.
- **`overdueCondition()` and `isOverdue()` are one definition in two languages** — the send window
  touches the same concept; if it needs a shared predicate, put it beside them and change together.
- **Business logic in `src/lib/**`.** The route handler parses, delegates, serialises.
- Validate every input at the boundary with Zod, including the lead select's value.
- **e2e: never a bare `fill()`** — go through `fillForm()`. Select by role, never CSS or test id.
  Timeouts belong in `playwright.config.ts`, not in a spec.
- Design tokens only; no raw hex, no gradients, no heavy shadows. No sections inside cards. Lists on
  mobile are cards, never tables.
- Next.js 16 is newer than most training data — read `node_modules/next/dist/docs/` before writing
  route-handler or cron code.
- `pnpm test:integration` needs the live stack and is where this phase's access model is proven —
  run it, and re-run `pnpm db:reset` after `0007` lands.

## Likely files

```
supabase/migrations/0007_reminders.sql          reminder_log + task_occurrence.reminder_lead_minutes
supabase/config.toml                            uncomment [local_smtp] smtp_port
src/lib/db/schema.ts                            mirror, by hand
src/lib/db/repos/reminders.ts (+ .test.ts)      claims-scoped log repo
src/lib/db/repos/profiles.ts                    + listActiveRecipientsAsAdmin()
src/lib/db/repos/occurrences.ts                 + reminderLeadMinutes on create/update/materialize
src/lib/reminders/{due,keys,run}.ts (+ tests)   pure selection; the orchestration
src/lib/email/{send,templates}.ts (+ tests)     SMTP transport + reminder template
src/lib/tasks/{validators,series-validators}.ts + lead validation
src/lib/tasks/feed.ts                           lead propagation at materialisation
src/app/api/cron/reminders/route.ts             bearer-guarded entry point
src/components/tasks/{task-form,series-form}.ts + reminder-select.tsx
vercel.json                                     cron declaration
tests/integration/rls-boundary.test.ts          + reminder_log block
tests/integration/reminders.test.ts             run-twice proof, done-skip, window
e2e/reminders.spec.ts                           Mailpit round trip
docs/gsd/devtask-pro-v1.md                      amend the materialisation decision
```

## Open items for Plan

1. **Does the reminder email deep-link to the task?** A virtual occurrence has no route of its own —
   `/today` and `/tasks` are the only destinations. Linking to `/tasks?from=<date>&to=<date>` reuses
   the existing filter validators; linking to `/today` is simpler and wrong for a reminder a day
   ahead. Plan decides, and it decides whether `NEXT_PUBLIC_SITE_URL` gains a required-in-production
   check.
2. **Does the lead control belong in the dialog body or behind the same disclosure as `repeat`?**
   `repeat-button.tsx` set a pattern for secondary task attributes. Adding a fourth always-visible
   control to the task dialog may crowd it on mobile.
3. **How many accounts per run before this needs paging?** `listAccountsAsAdmin` is capped at
   `ACCOUNT_LIST_LIMIT` for the UI; the job's enumeration must not inherit that cap silently. Decide
   between an explicit unbounded query with a comment and a cursor.
4. **Does the job's response body carry per-account detail?** Useful in dev, and a small information
   leak if the endpoint is ever reachable with a leaked secret. Leaning aggregate counts only.
5. **Should `sent_at` be the claim time or the delivery time?** They differ by the SMTP round trip.
   A single column cannot mean both, and criterion 21's proof only needs the claim.

