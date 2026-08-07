# devtask-pro phase 6 — plan

> GSD stage 2 of 5 · Discuss → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/phase-6-discuss.md` · Branch: `phase-6-reminders` → PR to `main`, never merged
> Phase 6 of 6: **email reminders** · Built on `main` in the main checkout — no worktree,
> no `config.toml` port parameterisation.

## Research — what was verified, not assumed

Every claim below was read out of the code this session.

| Fact | Where | Why it shapes the plan |
|---|---|---|
| `taskFields` feeds **both** `taskInput` and `taskUpdateInput`, and `UPDATABLE_FIELDS` derives from `Object.keys(taskFields)` | `src/lib/tasks/validators.ts:176,199` | Adding one field there wires create, update and the "nothing to update" refine at once. Do not add it three times. |
| `toPublicTask` takes a `ListedOccurrence`, not a row — one serialiser for stored and projected | `src/lib/trpc/routers/task.ts:72` | The lead must land on `ListedOccurrence`, not on the row type, or a projection cannot carry it. |
| `mergeOccurrences` is a union with **rows winning** | `src/lib/tasks/feed.ts:272` | Free dedupe: a materialised series date never also appears as a projection, so the job cannot generate two candidates for one key. |
| `withUser()` needs only `{ sub }` | `src/lib/db/rls.ts:68,72` | The job runs *inside* RLS. This is the whole access-model story of the phase. |
| `0006` added `task_series_id_user_key` and `task_occurrence_id_user_key` — `unique (id, user_id)` | `supabase/migrations/0006_tags.sql:59-63` | `reminder_log`'s FKs are composite against these. A plain `references task_series(id)` reopens the hole 0006's header describes at length. |
| `0004` revoked the default privilege that handed `Dxtm` to client roles | `supabase/migrations/0006_tags.sql:164-167` | `reminder_log` starts with an empty ACL. No `revoke` block needed; grants are exhaustive. |
| Untouched occurrences are not rows, and there is no untouched-row cleanup | `src/lib/db/repos/series.ts:209-214` | The job must not write `task_occurrence`. Criteria 15 and 17 depend on it. |
| `occurrenceDeadline(series, occursOn, tz)` resolves the instant per date | `src/lib/tasks/feed.ts:184` | Criterion 20 for reminders comes free by reusing it. Do not re-derive. |
| `[local_smtp]` has `smtp_port` **commented out**; web UI is 54424 | `supabase/config.toml:113-120` | Uncommenting to `54425` is required before any local send works, and it needs a stack **restart**, not a `db:reset`. |
| `isolation.test.ts` asserts the sanctioned `dbAdmin` importer set **exactly** | `src/lib/admin/isolation.test.ts:168,225` | If an executor reaches for `dbAdmin` in the job, this test fails. That is criterion 12 enforcing itself. |
| Integration config sets `fileParallelism: false` and loads `.env.local` | `vitest.integration.config.ts` | New integration specs get the live stack and run serially — safe to seed and assert against shared tables. |
| `AGENTS.md` requires a `rls-boundary.test.ts` block per new user-data table, added not restructured | `AGENTS.md` | Task 10. |

## Tasks

Thirteen tasks. `[seq]` must follow its stated dependency; `[par]` shares no file with anything else
in its group.

---

### 1. Migration `0007` and the schema mirror — `[seq, first]`

**Files:** `supabase/migrations/0007_reminders.sql` (new), `src/lib/db/schema.ts`

**Pattern to lift:** `0006_tags.sql` end to end — the composite-FK header, the four-policy block,
the explicit grants, the `comment on table` footer. `0005` for a bounded `check` on a lead column.

**Build:**

```sql
alter table public.task_occurrence
  add column reminder_lead_minutes integer
    check (reminder_lead_minutes is null
           or reminder_lead_minutes between 0 and 10080);

create table public.reminder_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,

  -- Exactly one of these. A series occurrence is identified by its rule and its
  -- date whether or not it is a row; a one-off is identified by its row.
  series_id     uuid,
  occurrence_id uuid,
  occurs_on     date not null,

  -- The instant the reminder was about. For a projected occurrence this is
  -- derived and stored nowhere else, so the ledger would not otherwise record
  -- why it fired.
  deadline_at   timestamptz not null,
  sent_at       timestamptz not null default now(),

  constraint reminder_log_one_target
    check (num_nonnulls(series_id, occurrence_id) = 1),
  constraint reminder_log_series_fk
    foreign key (series_id, user_id) references public.task_series (id, user_id)
    on delete cascade,
  constraint reminder_log_occurrence_fk
    foreign key (occurrence_id, user_id) references public.task_occurrence (id, user_id)
    on delete cascade
);

create unique index reminder_log_series_uniq
  on public.reminder_log (series_id, occurs_on) where series_id is not null;
create unique index reminder_log_occurrence_uniq
  on public.reminder_log (occurrence_id) where occurrence_id is not null;
create index reminder_log_user_idx on public.reminder_log (user_id);
```

RLS: enable, then **`select` and `insert` only** — and the migration must say why, since
`AGENTS.md` demands all four or a reason. The reason: the ledger is append-only. Granting `update`
or `delete` to `authenticated` would let the account a log row describes rewrite it, and the
at-most-once guarantee is exactly what must not be rewritable. FK cascades are system-internal and
do not consult grants or policies, so `on delete cascade` still works with no delete grant.
`grant all … to service_role`; `anon` gets nothing.

Mirror by hand in `schema.ts`: `reminderLeadMinutes` on `taskOccurrence` (comment it as phase 6's,
matching the existing one on `taskSeries` at `:262`), plus a `reminderLog` table and its
`ReminderLog` type. Note in a comment that the two unique indexes are partial and Drizzle cannot
express that — the same note `taskOccurrence` already carries at `:359`.

**Check:** `pnpm db:reset` applies all seven; `pnpm typecheck` passes; a manual
`insert … on conflict do nothing` twice against `reminder_log` writes one row.

---

### 2. The lead field travels end to end through data and validation — `[seq, after 1]`

**Files:** `src/lib/db/repos/occurrences.ts`, `src/lib/db/repos/series.ts`,
`src/lib/tasks/feed.ts`, `src/lib/tasks/validators.ts`, `src/lib/tasks/series-validators.ts`,
`src/lib/trpc/routers/task.ts`, `src/lib/trpc/routers/series.ts`, and the adjacent `.test.ts` files

**Pattern to lift:** how `deadlineAt` already travels — `taskFields` → `CreateOccurrenceInput` /
`UpdateOccurrencePatch` → `toPublicTask`. For the projection side, how `deadlineTime` becomes
`deadlineAt` in `fromSeries` (`feed.ts:229`).

**Build:**
- `reminderLeadMinutesField` in `validators.ts` — `z.number().int().min(0).max(10080).nullable().optional()`,
  with the same `undefined` ≠ `null` contract `taskDescriptionField` documents. Add it to
  `taskFields` **once**; create, update and `UPDATABLE_FIELDS` follow.
- The equivalent in `series-validators.ts`, added to `seriesFields`.
- `reminderLeadMinutes` on `CreateOccurrenceInput`, `UpdateOccurrencePatch`, `CreateSeriesInput`.
- `ListedOccurrence` gains `reminderLeadMinutes: number | null`. `fromRow` takes the row's;
  **`fromSeries` takes the series'** — this is the template-seeds-then-lets-go rule every other
  series field follows.
- `materializeOccurrence` (`feed.ts:499`) passes `patch.reminderLeadMinutes ?? series.reminderLeadMinutes`,
  matching how it already handles `deadlineAt` at `:521`.
- `toPublicTask` exposes it.

**Check:** existing suites stay green (they assert `reminderLeadMinutes: null` in fixtures already —
`feed.test.ts:85`, `series.test.ts:105`); new unit tests assert a projection inherits its series'
lead and a materialised occurrence keeps its own after the series' changes.

---

### 3. `reminder_log` repo — `[par with 4, after 1]`

**Files:** `src/lib/db/repos/reminders.ts`, `src/lib/db/repos/reminders.test.ts` (both new)

**Pattern to lift:** `repos/tags.ts` — the banner stating every function opens its own `withUser()`
and `dbAdmin` does not appear, `ownedBy(claims)`, and the source-level guard in its test asserting
the module does not import `dbAdmin`.

**Build:**
- `type ReminderKey = { kind: "series"; seriesId: string; occursOn: string } | { kind: "occurrence"; occurrenceId: string; occursOn: string }`
- `listSentKeys(claims, since: Date): Promise<ReminderKey[]>` — for the window under consideration.
- `claim(claims, key, deadlineAt): Promise<boolean>` — insert with
  `.onConflictDoNothing()` and `.returning({ id })`; `true` only when this call wrote the row.
  **This is the at-most-once mechanism**, and the doc comment must say so: the send happens only on
  `true`, so two overlapping runs cannot both send, and a send that throws afterwards is a missed
  reminder rather than a retried one — the trade-off recorded in the discuss brief.

**Check:** unit tests with a mocked `withUser`; the real proof is task 11's integration spec.

---

### 4. Active-recipient enumeration on the profiles repo — `[par with 3, after 1]`

**Files:** `src/lib/db/repos/profiles.ts`, `src/lib/db/repos/profiles.test.ts`

**Pattern to lift:** `listAccountsAsAdmin` (`:181`) — inside the existing fenced escalated section,
named `…AsAdmin` so `isolation.test.ts:264` still recognises it.

**Build:** `listActiveRecipientsAsAdmin(): Promise<{ id: string; email: string; timezone: string }[]>`,
filtered to `status = 'active'`. **Do not inherit `ACCOUNT_LIST_LIMIT`** — that cap exists for a UI
table and silently truncating the job's recipient list would drop people's mail with no error. Write
it unbounded with a comment saying why, and note the cursor this grows if the account count ever
justifies one.

**Check:** `isolation.test.ts` still passes unchanged — the new function names only `profiles`, and
`SANCTIONED_IMPORTERS` needs no new entry. `profiles.test.ts` asserts suspended, pending and
rejected accounts are excluded.

---

### 5. The pure selection function — `[par, no dependency beyond task 2's type]`

**Files:** `src/lib/reminders/due.ts`, `src/lib/reminders/due.test.ts` (both new)

**Pattern to lift:** `src/lib/tasks/overdue.ts` — a pure predicate taking `now` explicitly, never
reading a clock, and unit-tested against fixed instants.

**Build:**
- `reminderKeyFor(o: ListedOccurrence): ReminderKey | null` — `series` kind when `seriesId` is set
  (materialised **or** projected, which is criterion 6), `occurrence` kind otherwise.
- `fireAt(o: ListedOccurrence): Date | null` — `deadlineAt − lead × 60_000`.
- `dueReminders(feed: ListedOccurrence[], now: Date): ReminderCandidate[]` — keeps an entry only
  when the lead is non-null, the deadline is non-null, `status !== "done"`, and
  `fireAt <= now < deadlineAt`. **The right-hand bound is the send window decision**: a reminder
  that missed its moment is skipped, not delivered late.

**Check:** unit tests for every criterion this owns — no deadline, no lead, `done`, already past,
exactly at `fireAt`, one millisecond before `deadlineAt`, and the Manila/DST case (criterion 9)
driven through `occurrenceDeadline`.

---

### 6. Email transport and template — `[par, no dependency]`

**Files:** `src/lib/email/send.ts`, `src/lib/email/templates.ts`, `src/lib/email/templates.test.ts`
(all new), `supabase/config.toml`, `package.json`

**Build:**
- Add `nodemailer` and `@types/nodemailer`.
- `templates.ts` — pure `reminderEmail({ title, deadlineAt, timeZone, url }) → { subject, text, html }`.
  Formats the deadline in the **recipient's** zone via `src/lib/time/`, never the server's. No raw
  hex is required here (`src/components/**` is what `AGENTS.md` scopes), but keep the HTML plain:
  no gradients, no images, table-free.
- `send.ts` — one `sendMail()` behind one module, transport built from `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`. Local values are `127.0.0.1` / `54425` / no auth.
- `supabase/config.toml`: uncomment `smtp_port` under `[local_smtp]` and set it to **`54425`**
  (main's stack is 5442x; the file's own commented default of 54325 is for the vanilla stack).
  **This edit is committed** — unlike the worktree port edits of phases 3–5.

**Check:** template unit tests assert subject and body copy and that the time renders in the given
zone. Transport is proven by task 12's Mailpit round trip.

---

### 7. The run orchestration — `[seq, after 2–6]`

**Files:** `src/lib/reminders/run.ts`, `src/lib/reminders/run.test.ts` (both new)

**Build:** `runReminders(now: Date): Promise<ReminderRunSummary>`

1. `profiles.listActiveRecipientsAsAdmin()` — the **only** `dbAdmin` touch, and it is inside the
   already-fenced profiles repo.
2. Per recipient, `feed.listAllFeed({ sub: id }, todayInZone(tz, now), tz)` — the ordinary read
   path, inside `withUser()`. **Reusing the feed is the point**: the reminder sees exactly what the
   user sees, `mergeOccurrences` dedupes materialised against projected for free, and the phase adds
   no new task query to review. Record the cost in the doc comment — the feed loads tags and
   unwindowed rows the job does not need, which is wasteful and correct, and the leaner query is the
   optimisation to reach for only if account volume ever justifies it.
3. `dueReminders(feed, now)`.
4. Per candidate: `reminders.claim(...)`, and **only on `true`**, `sendMail(...)`.
5. Return aggregate counts — `{ recipients, candidates, claimed, sent, failed, skippedLate }`.

A throwing send is caught, counted in `failed`, and logged; it must not abort the run for the other
recipients.

**Check:** unit tests with the repo and mailer mocked — claim returning `false` sends nothing; a
throwing send does not stop the loop; a suspended recipient never appears.

---

### 8. Route handler and cron declaration — `[seq, after 7]`

**Files:** `src/app/api/cron/reminders/route.ts` (new), `vercel.json` (new)

**Pattern to lift:** `src/app/auth/callback/route.ts` — parse, delegate, respond; no logic in the
handler.

**Build:**
- `GET` (Vercel Cron issues GET). Compare `Authorization: Bearer <CRON_SECRET>` and return **401
  with no work done** on mismatch or on a missing/empty configured secret. Use a length-safe
  comparison.
- Delegate to `runReminders(new Date())`. Respond with **aggregate counts only** — no per-account
  detail, so a leaked secret does not also enumerate accounts (open item 4, decided).
- `vercel.json`: `{ "crons": [{ "path": "/api/cron/reminders", "schedule": "*/5 * * * *" }] }`, with
  a note that Vercel Hobby caps cron at one run per day, which would leave only the 1-day preset
  meaningful. Deployment stays deferred; this is a declaration to revisit.

**Check:** `pnpm build` emits the route; a `curl` without the bearer returns 401 and writes nothing.

---

### 9. The reminder control in both dialogs — `[seq, after 2]`

**Files:** `src/components/tasks/reminder-select.tsx` (new), `src/components/tasks/task-form.ts`,
`src/components/tasks/task-dialog.tsx`, `src/components/tasks/series-form.ts`,
`src/components/tasks/series-dialog.tsx`, and the adjacent `.test.ts` files

**Pattern to lift:** `status-control.tsx` for a small labelled select; `task-form.ts`'s
`TaskFormValues` → `wireValues` → `buildUpdatePatch` change-detection for the state plumbing.

**Build:**
- `REMINDER_PRESETS` — `none | 15 | 30 | 60 | 1440`, exported from a lib file, not the component.
  Labels: "No reminder", "15 minutes before", "30 minutes before", "1 hour before", "1 day before".
- `reminderLeadMinutes` on `TaskFormValues` / `SeriesFormValues`, seeded in
  `initialTaskFormValues` / its series equivalent, carried through `wireValues`, and compared in
  `buildUpdatePatch` so an unchanged form still sends nothing.
- Disabled with a short explanation when the task has no deadline (task dialog) or the series has no
  `deadlineTime` (series dialog) — a lead with nothing to count back from is meaningless.
- Design tokens only, no new card sections, and the control keeps its accessible name stable so the
  e2e role selectors in task 12 work at both viewports.

**Check:** form unit tests for seeding, change detection and the disabled case; `pnpm lint` clean of
raw hex.

---

### 10. The boundary proof — `[seq, after 1; may run alongside 7–9]`

**Files:** `tests/integration/rls-boundary.test.ts`

**Pattern to lift:** the `tags` block at `:1076` — same two-user-plus-admin harness, added as a
**new `describe`**, not a restructure.

**Build:** assert (a) an admin session selecting `reminder_log` gets **zero rows**, (b) user B cannot
read or insert against user A's rows, (c) `authenticated` holds no `update` or `delete` privilege on
the table, so a log row cannot be rewritten by the account it describes.

**Check:** `pnpm test:integration` passes; the new block fails if the grants in `0007` are widened.

---

### 11. The two open criteria, proven — `[seq, after 7 and 10]`

**Files:** `tests/integration/reminders.test.ts` (new)

**Build:**
- **Criterion 1 [21]:** seed a due one-off and a due series occurrence, run `runReminders` **twice**,
  assert one `reminder_log` row each and one Mailpit message each.
- **Criterion 2 [22]:** a `done` occurrence produces nothing.
- **Criterion 3:** count `task_occurrence` rows and capture `updated_at` before and after a run over
  a series with due reminders — **byte-identical**. This is the no-materialisation guarantee.
- **Criteria 4 and 5:** remind on a virtual occurrence, then edit the rule so the date is no longer
  named / soft-delete the series, and assert the feed shows nothing on that date.
- **Criterion 6:** remind on a virtual occurrence, materialise it through `task.update`, run again —
  no second send, because the key is `(series_id, occurs_on)` on both sides.
- **Criteria 7, 8, 10:** past-deadline skip; no-deadline and no-lead silence; suspended recipient
  skipped.

**Check:** `pnpm test:integration` green, and green a second time without a reset — the specs must
not depend on a virgin database.

---

### 12. End-to-end — `[seq, after 8, 9, 11]`

**Files:** `e2e/reminders.spec.ts` (new)

**Pattern to lift:** `e2e/admin.spec.ts:272` for the Mailpit round trip; `e2e/helpers/tasks.ts`
`seedTask` / `hoursFromNow` for arranging a deadline a known distance away — the sanctioned use of
the service role, for an arrangement the UI is deliberately awkward at.

**Build:** set a reminder through the dialog **by role**, seed a task whose deadline is inside the
lead window, hit the cron route with the bearer, and assert the message arrives in Mailpit. Then hit
it again and assert no second message.

**Check:** `pnpm test:e2e` green on chromium **and** mobile/WebKit. `fillForm()` only — never a bare
`fill()`. Timeouts live in `playwright.config.ts`.

---

### 13. Amend the record — `[par, anytime]`

**Files:** `docs/gsd/devtask-pro-v1.md`, `AGENTS.md`

**Build:** amend the decision at `devtask-pro-v1.md:143` and the `reminder_log` line of the data
sketch — the job does not materialise, and the log carries occurrence identity. State the reason
(criteria 15 and 17 depend on untouched occurrences never being rows) so the next reader does not
re-decide it. In `AGENTS.md`, narrow the reminder-job entry in the `dbAdmin` caller list: profiles
enumeration only, never a task table.

**Check:** no code change; the amended text matches what tasks 1–12 actually built.

---

## Ordering

```
1 ─┬─ 2 ─┬─ 9 ────────────────┐
   │     └─ 5 ─┐              │
   ├─ 3 ───────┼─ 7 ─ 8 ──────┼─ 12
   ├─ 4 ───────┘   │          │
   └─ 10 ──────────┴─ 11 ─────┘
6 (independent) ───┘
13 (independent)
```

Parallel-safe groups: **{3, 4, 6}** after task 1, and **{5}** once task 2's type exists. Everything
else is sequential on a shared file. Tasks 2 and 9 both touch the task form layer and must not run
concurrently.

## Verify gates

From `AGENTS.md`, not guessed:

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

All four before the PR. Additionally, because this phase touches data access and adds a table:

```bash
pnpm test:integration    # needs the live stack — where the access model is actually proven
pnpm test:e2e            # the Mailpit round trip
```

`pnpm db:reset` after task 1 lands, and `pnpm supabase stop && pnpm db:start` after task 6 — a
`config.toml` change needs a stack restart, not a database reset.

## Branch / PR target

`phase-6-reminders` → PR into `main`. The session opens the PR and **never merges**.

## Risks and rollbacks

1. **The stack drifts behind the migrations.** The 2026-08-07 audit lost time to exactly this: 21
   integration failures reading as a broken phase, actually a stack still at `0004`. After task 1,
   run `pnpm db:reset` and confirm `supabase_migrations.schema_migrations` lists all seven before
   trusting any integration failure.
2. **A `config.toml` edit needs a restart.** `pnpm db:reset` will not open port 54425. Symptom is
   `ECONNREFUSED` from nodemailer that looks like a code bug.
3. **The executor reaches for `dbAdmin` in the job.** `isolation.test.ts` fails loudly, which is the
   design working. The fix is `withUser({ sub: id })`, never widening `SANCTIONED_IMPORTERS`.
4. **Reusing `listAllFeed` is wasteful.** Accepted deliberately for correctness. If it ever matters,
   the optimisation is a narrower reminder-candidate query in `feed.ts` — not a `dbAdmin` scan.
5. **Cron cadence versus Vercel Hobby.** Declared at 5 minutes; Hobby permits one run per day.
   Deployment is deferred, so this surfaces at deploy time, not now. Recorded in `vercel.json`.
6. **Rollback:** every task is its own commit. `0007` is additive — a revert drops `reminder_log`
   and one nullable column, and phases 1–5 are untouched by construction, which task 11's criterion
   3 asserts directly.
