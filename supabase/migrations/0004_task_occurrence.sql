-- 0004_task_occurrence.sql
--
-- `task_occurrence`: the trackable unit of work, and the first table that holds
-- data a person would mind other people reading.
--
-- WHY ONE TABLE AND NOT TWO
-- A one-off task and a single instance of a recurring task are the same thing to
-- everyone who uses the app: a title, a day, a status, a progress figure. They differ
-- only in where they came from. So there is one table, and a one-off is simply a row
-- with `series_id IS NULL`. Every read path — /today, /tasks, /overdue — is one query
-- rather than a union of two, and phase 3 adds recurrence without re-shaping any of it.
--
-- WHY `series_id` HAS NO FOREIGN KEY YET
-- `task_series` arrives in phase 3. The column is declared now so the shape is settled
-- and no later migration has to rewrite the table, but the FK and the
-- `unique (series_id, occurs_on) where series_id is not null` index are deliberately
-- deferred to the migration that creates the table they point at. Every row written in
-- phase 2 has `series_id = NULL`, so both constraints will be trivially satisfiable when
-- they are added. The alternative — shipping a ~20-column `task_series` now — would put
-- a table and a full policy set into the database that no feature exercises.
--
-- WHY `occurs_on` AND `deadline_at` ARE DIFFERENT COLUMNS
-- They answer different questions. `occurs_on` is "the day I mean to do this", which is
-- what /today groups by; `deadline_at` is "the moment this becomes late", which is what
-- overdue compares against. Collapsing them would mean a task with no deadline could
-- never appear on a day, and a task due at 23:00 could not be planned for the morning.
--
-- `deadline_at` is `timestamptz`, so `deadline_at < now()` is an absolute comparison and
-- overdue is correct regardless of the server's timezone. `occurs_on` is a bare `date`
-- because it is a human intention about a calendar square, not an instant — it must not
-- shift when the user travels or the server moves.
--
-- OVERDUE IS NOT A COLUMN. It is `deadline_at < now() and status <> 'done'`, evaluated
-- at read time. Storing it would need a job to keep it true, would be wrong between
-- runs, and would destroy the underlying todo/in_progress status the UI still shows.

create table public.task_occurrence (
  id            uuid primary key default gen_random_uuid(),

  -- Owner. References `public.profiles` rather than `auth.users` directly: the two ids
  -- are the same value (0001), but pointing at the public table keeps the FK inside the
  -- schema Drizzle can actually express, so `schema.ts` mirrors it instead of carrying
  -- another "declared in SQL only" caveat. Deletion still cascades the whole way —
  -- auth.users -> profiles (0001) -> here.
  user_id       uuid not null references public.profiles (id) on delete cascade,

  -- Set in phase 3. NULL means "a one-off task", which is every row this phase writes.
  -- No FK yet, on purpose — see the note above.
  series_id     uuid,

  title         text not null check (length(btrim(title)) between 1 and 200),
  description   text check (description is null or length(description) <= 2000),

  -- The calendar day this belongs to, in the owner's timezone. Never null: a task
  -- always sits on some day, and a nullable variant would split /today into two queries.
  occurs_on     date not null,

  -- Optional. NULL means "no deadline", and a NULL never satisfies `deadline_at < now()`,
  -- so such a task is never overdue however old it gets. That is acceptance criterion 8,
  -- and it falls out of three-valued logic rather than needing a special case.
  deadline_at   timestamptz,

  -- Enums are text + CHECK by house convention (see 0001), easier to extend than a pg
  -- enum type. Freely reversible: done -> in_progress is a legitimate move.
  status        text not null default 'todo'
                  check (status in ('todo', 'in_progress', 'done')),

  -- Set by hand and deliberately independent of status: a done task may sit at 40% and
  -- must keep both facts. The CHECK is the database's half of acceptance criterion 12;
  -- Zod enforces the same bounds at the tRPC boundary for a better error message.
  progress_pct  integer not null default 0
                  check (progress_pct between 0 and 100),

  -- Maintained by the trigger below, not by application code.
  completed_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- Both are (user_id, ...) leading, because RLS adds `user_id = auth.uid()` to every
-- single query on this table — a bare index on the second column alone would leave the
-- planner filtering after the fact.
--
-- /today and /tasks group by day:
create index task_occurrence_user_day_idx
  on public.task_occurrence (user_id, occurs_on);

-- /overdue scans by deadline. Partial, because rows with no deadline can never be
-- overdue and rows that are done are excluded by the predicate anyway — so they have no
-- business in the index. Keeps it to the rows the query can actually return.
create index task_occurrence_user_deadline_idx
  on public.task_occurrence (user_id, deadline_at)
  where deadline_at is not null and status <> 'done';

-- Phase 3 will add:
--   alter table public.task_occurrence
--     add constraint task_occurrence_series_fk
--     foreign key (series_id) references public.task_series (id) on delete cascade;
--   create unique index task_occurrence_series_day_uniq
--     on public.task_occurrence (series_id, occurs_on) where series_id is not null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Reuses the generic function from 0002.
create trigger task_occurrence_touch_updated_at
  before update on public.task_occurrence
  for each row
  execute function public.touch_updated_at();

-- `completed_at` is derived from `status`, so the database derives it. Leaving it to
-- application code means every write path — the router, the reminder job in phase 6, a
-- future bulk action — has to remember the same two-line rule, and one of them
-- eventually will not. Keeping it here also means a row can never claim to be done
-- without a completion time, or carry a stale one after being reopened.
create or replace function public.sync_task_completed_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'done' then
    -- Preserve the original completion time when a done row is edited for some other
    -- reason; only stamp it when the row is actually arriving at done.
    if tg_op = 'INSERT' or old.status is distinct from 'done' then
      new.completed_at = now();
    end if;
  else
    new.completed_at = null;
  end if;

  return new;
end;
$$;

comment on function public.sync_task_completed_at() is
  'BEFORE INSERT OR UPDATE on task_occurrence: stamps completed_at when a row reaches '
  'done, preserves it while it stays done, and clears it when the row is reopened.';

create trigger task_occurrence_sync_completed_at
  before insert or update on public.task_occurrence
  for each row
  execute function public.sync_task_completed_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- THIS IS THE TABLE THE PRODUCT PROMISE IS ABOUT. "Nobody sees anybody else's tasks,
-- including admins" is enforced here, by the database, and not by remembering to write
-- a `.where()`. `tests/integration/rls-boundary.test.ts` is the proof.
--
-- Note what is NOT here: the escalation-guard trigger from 0003. That exists because
-- `profiles` holds `role` and `status` — columns whose owner must not be allowed to
-- move them. `task_occurrence` has no privileged column; every field on it is the
-- owner's to change. Copying the guard across would be cargo cult.

alter table public.task_occurrence enable row level security;

-- ---------------------------------------------------------------------------
-- THE IMPLICIT-GRANT HOLE  <-- read this before adding any table
-- ---------------------------------------------------------------------------
--
-- Supabase no longer auto-exposes new public tables for *DML*, which is why 0003 tells
-- you to grant select/insert/... explicitly. What that note misses is that new tables
-- are not created with an empty ACL either. `postgres` — the role migrations run as —
-- carries a default privilege in this schema:
--
--     postgres | tables | anon=Dxtm/postgres  authenticated=Dxtm/postgres
--
-- `D` is TRUNCATE. So every table created here silently starts out letting **any
-- authenticated user truncate it**, and TRUNCATE does not consult row level security.
-- One signed-in account could empty every other account's task list, and not one
-- policy above would object. Verified on this stack, not inferred:
--
--     set role authenticated; truncate public.task_occurrence;  -> TRUNCATE TABLE
--
-- `x` (REFERENCES) and `t` (TRIGGER) come along too — a foreign key pointed at your
-- table, or a trigger attached to it, are likewise not things a client role should have.
--
-- Two fixes, because one alone is not enough:
--
--   1. Kill the default, so no future table inherits it. This is the root cause, and it
--      is why `task_series` (phase 3), `tags` (phase 4) and `reminder_log` (phase 6) do
--      not each have to remember. From here on a client role holds exactly what a
--      migration granted it and nothing else.
--
--   2. Revoke what the already-created tables picked up. `profiles` is included: it was
--      created in 0001 and has carried the same hole since. 0003 is already applied and
--      merged, so it stays immutable — the correction belongs in a new migration, which
--      is this one.
alter default privileges in schema public
  revoke all on tables from anon, authenticated;

revoke all on public.task_occurrence from anon, authenticated;
revoke all on public.profiles          from anon, authenticated;

-- Now grant back precisely what each role needs, and nothing more.
--
-- Unlike `profiles`, this table gets all four verbs: tasks are created and deleted by
-- the people who own them. `anon` gets nothing at all — there is no public task, and
-- after the revoke above that is now literally true rather than merely intended.
grant select, insert, update, delete on public.task_occurrence to authenticated;
grant all on public.task_occurrence to service_role;

-- Restores 0003's stated intent for `profiles`: select + update only. No insert (the
-- `handle_new_user` trigger creates the row as definer) and no delete (removal happens
-- through auth.users and cascades).
grant select, update on public.profiles to authenticated;

-- `(select auth.uid())` rather than a bare `auth.uid()`, as in 0003: the scalar
-- subquery lets the planner hoist it into an InitPlan and evaluate it once per
-- statement instead of once per row. Same semantics, materially cheaper on a table
-- that is listed rather than fetched by primary key.

create policy "task_occurrence_select_own"
  on public.task_occurrence
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- INSERT has no USING clause — there is no existing row to test. WITH CHECK is what
-- stops a caller creating a row owned by somebody else, which is the whole risk here:
-- without it, any authenticated user could plant tasks in another person's list.
create policy "task_occurrence_insert_own"
  on public.task_occurrence
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- USING picks which rows may be targeted; WITH CHECK says what they may look like
-- afterwards. Both are required. USING alone would let an owner re-point `user_id` at
-- another account — handing the row away, or worse, planting it.
create policy "task_occurrence_update_own"
  on public.task_occurrence
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "task_occurrence_delete_own"
  on public.task_occurrence
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

comment on table public.task_occurrence is
  'The trackable unit of work. series_id IS NULL means a one-off task; phase 3 adds '
  'task_series and the FK. Overdue is derived (deadline_at < now() and status <> done), '
  'never stored. RLS scopes every row to its owner — admins included.';

comment on column public.task_occurrence.occurs_on is
  'The calendar day this task belongs to, in the owner''s timezone. A date, not an '
  'instant: it is an intention about a calendar square and must not shift with travel.';

comment on column public.task_occurrence.deadline_at is
  'Optional. NULL is never < now(), so a task with no deadline is never overdue.';

comment on column public.task_occurrence.progress_pct is
  'Set by hand, independent of status. A done task may legitimately sit at 40%.';
