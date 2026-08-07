-- 0007_reminders.sql
--
-- `reminder_log`, the at-most-once ledger behind acceptance criteria 21 and 22,
-- and the `reminder_lead_minutes` column `task_occurrence` never got. 0005 gave
-- one to `task_series` and said "nothing reads it yet"; this is the migration
-- that makes both of them mean something.
--
-- ===========================================================================
-- THE DECISION THIS FILE ENCODES: THE JOB DOES NOT MATERIALISE
-- ===========================================================================
--
-- `docs/gsd/devtask-pro-v1.md` originally had the reminder job materialise
-- occurrences inside its horizon, and keyed this table on `occurrence_id` alone.
-- Phase 3 then shipped acceptance criteria 15 and 17 on the opposite premise.
-- `src/lib/db/repos/series.ts` states the mechanism outright: untouched future
-- occurrences vanish on a rule edit or a series delete *because they were never
-- rows*. There is no untouched-row cleanup anywhere in this codebase, because
-- until now nothing but a user's own touch could create a row.
--
-- A job that materialised untouched upcoming occurrences would therefore leave:
--
--   * rows on dates a later rule edit no longer names — and the read path is a
--     union with rows winning (`src/lib/tasks/feed.ts`), not a filter, so they
--     would still appear. Criterion 15 fails.
--   * rows that outlive `softDelete`, which only tombstones the series and
--     deliberately writes nothing to `task_occurrence`. Criterion 17 fails.
--
-- So the job reads and sends and writes nothing but this table, and a reminder
-- is identified by *which occurrence it was about* rather than by a row id:
--
--   a series occurrence  →  (series_id, occurs_on)
--   a one-off task       →  (occurrence_id)
--
-- The series key is deliberately the same whether or not that date has been
-- materialised. That is what stops a second reminder firing when somebody
-- touches a date the job already reminded them about — the identity does not
-- change underneath the ledger.
--
-- ===========================================================================
-- COMPOSITE FOREIGN KEYS, FOR THE REASON 0006 GIVES AT LENGTH
-- ===========================================================================
--
-- A foreign key check does not consult row level security. `(user_id, series_id)`
-- referencing `task_series (id, user_id)` is what makes "this log row and the
-- series it names belong to the same person" a thing the database enforces
-- rather than a thing a policy is trusted to have got right. 0006 created the
-- `unique (id, user_id)` keys on both parents that these point at.

-- ---------------------------------------------------------------------------
-- The column 0005's twin never got
-- ---------------------------------------------------------------------------
--
-- Same bound as `task_series.reminder_lead_minutes` (0..10080 — a week), and the
-- same NULL meaning: no reminder. A one-off task carries its own; a materialised
-- occurrence is seeded from its series and then owns the value, which is the
-- rule every other series field already follows.

alter table public.task_occurrence
  add column reminder_lead_minutes integer
    check (reminder_lead_minutes is null
           or reminder_lead_minutes between 0 and 10080);

-- ---------------------------------------------------------------------------
-- reminder_log
-- ---------------------------------------------------------------------------

create table public.reminder_log (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles (id) on delete cascade,

  -- Exactly one of these two, enforced below. See the header.
  series_id     uuid,
  occurrence_id uuid,

  -- The calendar square the reminder was about. Set for both kinds: a one-off
  -- has an `occurs_on` too, and carrying it makes the ledger readable on its own
  -- without joining back to a row that may since have been deleted.
  occurs_on     date not null,

  -- The instant the reminder was counting back from. For a *projected*
  -- occurrence this value is derived at send time and stored nowhere else in the
  -- database, so without it the ledger could not say why it fired.
  deadline_at   timestamptz not null,

  -- The instant the send was CLAIMED, not confirmed delivered.
  --
  -- The job inserts this row with `on conflict do nothing returning` and sends
  -- only if the insert won. That ordering is what makes two overlapping runs
  -- unable to both send, and it is the whole of criterion 21. The cost, accepted
  -- deliberately: a send that throws after the claim is a missed reminder rather
  -- than a retried one. The criterion is *at most once*; at-least-once would need
  -- a retry ledger and a poison-message story, which this feature does not earn.
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

-- The two identities, one partial index each.
--
-- Partial for the same reason `task_occurrence_series_day_uniq` is (0005): every
-- one-off shares `series_id IS NULL` and must not collide with every other
-- one-off, and vice versa. `user_id` is absent from both because `series_id` and
-- `occurrence_id` each already determine their owner — the composite FKs above
-- are what guarantee that.
create unique index reminder_log_series_uniq
  on public.reminder_log (series_id, occurs_on) where series_id is not null;

create unique index reminder_log_occurrence_uniq
  on public.reminder_log (occurrence_id) where occurrence_id is not null;

create index reminder_log_user_idx on public.reminder_log (user_id);

-- No `touch_updated_at` trigger, and no `updated_at` column: this is an
-- append-only ledger. Nothing edits a row here — see the grants.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- No `revoke` block, for the reason 0004 established: the `alter default
-- privileges` that used to hand TRUNCATE to `anon` and `authenticated` on every
-- new table in this schema is gone, so this table starts with an empty ACL and
-- holds exactly what is granted below.
--
-- ## Why only two policies, not the four AGENTS.md asks for
--
-- Because this table is an append-only ledger and `update` and `delete` are not
-- operations it has. A signed-in account may read the record of what was sent to
-- it and may cause a row to be written by being reminded — it must not be able
-- to rewrite or erase that record, because "a reminder was already sent for this
-- occurrence" is the fact criterion 21 rests on, and an account that can delete
-- its own log rows can make the job send again.
--
-- So `authenticated` gets `select` and `insert` and no more, and there are two
-- policies rather than four because there are two verbs rather than four. The
-- insert policy still carries a `with check` — without it a caller could write a
-- row owned by somebody else, which is the trap 0004's header describes.
--
-- The cascades on both foreign keys still work with no delete privilege: a
-- referential action runs as a system-internal operation and consults neither
-- grants nor policies. Deleting a one-off task therefore still takes its log row
-- with it.

alter table public.reminder_log enable row level security;

grant select, insert on public.reminder_log to authenticated;
grant all           on public.reminder_log to service_role;
-- `anon` gets nothing. There is no publicly readable reminder.

create policy "reminder_log_select_own" on public.reminder_log
  for select to authenticated using (user_id = (select auth.uid()));

create policy "reminder_log_insert_own" on public.reminder_log
  for insert to authenticated with check (user_id = (select auth.uid()));

comment on table public.reminder_log is
  'At-most-once ledger for deadline reminder emails. Append-only: authenticated '
  'holds select and insert and nothing else, because an account that could delete '
  'its own rows could make the job send again. A row is keyed by (series_id, '
  'occurs_on) for a recurring occurrence — materialised or not — and by '
  'occurrence_id for a one-off. The job never writes task_occurrence; see the '
  'header of this migration.';

comment on column public.reminder_log.sent_at is
  'When the send was CLAIMED, not when delivery was confirmed. The insert wins '
  'the right to send; a throw afterwards is a missed reminder, not a retried one.';

comment on column public.task_occurrence.reminder_lead_minutes is
  'Minutes before deadline_at to email a reminder, or NULL for none. Seeded from '
  'the series at materialisation and independent thereafter, like every other '
  'series field.';
