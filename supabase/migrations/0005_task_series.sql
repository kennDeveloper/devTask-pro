-- 0005_task_series.sql
--
-- `task_series`: the repeat rule, and the two constraints on `task_occurrence`
-- that 0004 deliberately left for this migration to add.
--
-- WHAT A SERIES IS, AND WHAT IT IS NOT
-- A series is a *rule*, not a task. It names dates; it has no status, no progress
-- and no completion. The trackable thing is still a `task_occurrence` row — which
-- is why 0004 says "one read path, not two" and why this table adds no second
-- notion of doneness. `/today`, `/tasks` and `/overdue` keep the shape they had.
--
-- OCCURRENCES ARE MATERIALISED ON TOUCH, NEVER ON READ
-- Reading a list expands the rule in memory for the window being viewed and
-- left-joins whatever rows already exist. A row is written the first time a
-- person acts on a specific date (sets a status, moves a slider). Two
-- consequences worth stating, because they are the whole design:
--
--   * A row exists **because somebody touched that date.** "Untouched" is
--     therefore a fact about history rather than about current values — an
--     occurrence set to in_progress and back to todo keeps its row.
--   * Editing the rule writes nothing and deletes nothing. Untouched
--     occurrences were never rows, so they simply move; touched ones are rows
--     and keep everything they carry, including on a date the new rule no longer
--     names. The read path is a union keyed on `occurs_on`, not a filter.
--
-- WHY `deadline_time` IS A `time` AND NOT AN INTERVAL FROM MIDNIGHT
-- A recurring task set to 09:00 must fire at 09:00 local on both sides of a DST
-- transition (acceptance criterion 20). The instant is therefore *computed* at
-- read time from (occurs_on + deadline_time) resolved in the account holder's
-- zone, so the offset in force on that particular day is the one used. Storing
-- an instant plus a fixed interval drifts by an hour for half the year.
--
-- On materialisation the computed instant is frozen into the row's
-- `deadline_at`, consistent with 0004's rule that `occurs_on` is a user
-- intention rather than a derived value: changing your timezone later moves
-- future untouched occurrences and leaves recorded ones alone.
--
-- WHY `deleted_at` IS HERE AND NOT ON `task_occurrence`
-- Phase 2 settled hard delete for occurrences. Acceptance criterion 17 needs
-- deleting a series to remove the untouched future while leaving completed
-- history intact — and both halves fall out of a soft delete: a deleted series
-- is not expanded, so its virtual occurrences vanish, while its materialised
-- rows still resolve their `series_id` and stay exactly where they were.

create table public.task_series (
  id            uuid primary key default gen_random_uuid(),

  -- Same ownership shape as `task_occurrence` in 0004: a FK to `public.profiles`
  -- rather than `auth.users`, so Drizzle can mirror it, cascading the whole way
  -- from auth.users -> profiles -> here.
  user_id       uuid not null references public.profiles (id) on delete cascade,

  -- The template every occurrence is rendered from. Same bounds as
  -- `task_occurrence`, because an occurrence is written from these values and a
  -- looser limit here would produce a row the other table's CHECK refuses.
  title         text not null check (length(btrim(title)) between 1 and 200),
  description   text check (description is null or length(description) <= 2000),

  -- ---------------------------------------------------------------------
  -- The rule
  -- ---------------------------------------------------------------------
  --
  -- Stored as typed columns *and* as a serialised RFC 5545 string. The columns
  -- are what the editor binds to and what a query could one day filter on; the
  -- string is what makes adopting the `rrule` package later an additive change
  -- rather than a migration. `rrule` is derived from the columns by
  -- `src/lib/recurrence/serialize.ts` and is never the input.

  freq          text not null
                  check (freq in ('daily', 'weekly', 'monthly', 'yearly')),

  -- "every N days/weeks/months/years". Bounded at 365 because the editor offers
  -- a number field and an unbounded one invites a value that expands to nothing
  -- for a human lifetime, which reads as a broken rule rather than a silly one.
  -- Note `interval` needs no quoting here: Postgres only parses INTERVAL as a
  -- type constructor when a literal follows it. Verified on this stack.
  interval      integer not null default 1
                  check (interval between 1 and 365),

  -- WEEKLY only. RFC 5545 two-letter codes, so the array is already the BYDAY
  -- value rather than something that has to be translated on the way out.
  -- An empty array is legal and means "the weekday `starts_on` falls on", again
  -- per RFC 5545 — the editor never produces one, but the expander honours it.
  byweekday     text[] not null default '{}'
                  check (byweekday <@ array['MO','TU','WE','TH','FR','SA','SU']::text[]),

  -- MONTHLY only. Two genuinely different rules that a single "day" column
  -- cannot express: "the 15th" and "the last Friday" pick different dates in
  -- every month and neither can be derived from the other.
  month_mode    text check (month_mode in ('by_date', 'by_nth_weekday')),
  month_day     integer check (month_day between 1 and 31),
  -- 1..4, or -1 for "last". There is no -2: "second to last" is not on Google
  -- Calendar's repeat menu and is not in scope.
  nth_week      integer check (nth_week in (1, 2, 3, 4, -1)),
  nth_weekday   text check (nth_weekday in ('MO','TU','WE','TH','FR','SA','SU')),

  -- The first candidate date, and the anchor everything counts from. A `date`
  -- for the same reason `occurs_on` is one: it is a calendar square.
  starts_on     date not null,

  -- Wall-clock time of day, no zone. NULL means the occurrences have no
  -- deadline — and a NULL `deadline_at` is never < now(), so such a series is
  -- never overdue however old it gets (acceptance criterion 8, inherited).
  deadline_time time,

  -- ---------------------------------------------------------------------
  -- The three end conditions
  -- ---------------------------------------------------------------------
  ends_mode     text not null default 'never'
                  check (ends_mode in ('never', 'on', 'after')),
  ends_on       date,
  -- Bounded so `expand()`'s own cap is never the thing that truncates a rule the
  -- user could legitimately write.
  ends_count    integer check (ends_count between 1 and 365),

  -- The serialised rule, RFC 5545-valid. NOT NULL because a row without it would
  -- be a series whose rule could not be handed to anything that speaks RRULE.
  rrule         text not null check (length(rrule) between 1 and 500),

  -- Phase 6. Declared now because the brief sanctions it and because adding a
  -- column to a table with policies is a second migration; nothing reads it yet.
  reminder_lead_minutes integer
                  check (reminder_lead_minutes is null
                         or reminder_lead_minutes between 0 and 10080),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Soft delete. See the header: this is what makes criterion 17 work without a
  -- job and without touching a single occurrence row.
  deleted_at    timestamptz,

  -- ---------------------------------------------------------------------
  -- Cross-column rules
  -- ---------------------------------------------------------------------
  --
  -- Each of these is also enforced by Zod at the tRPC boundary, which is where a
  -- user gets a sentence instead of a constraint name. These are the boundary:
  -- if the two ever disagree, this one wins, loudly, which is the correct
  -- failure.
  --
  -- `case` rather than the tempting `(a) = (b)` equivalence: when the left side
  -- is NULL that expression evaluates to NULL, and a CHECK passes on NULL. The
  -- explicit `else` is what makes "month_mode is null therefore month_day must
  -- be null too" actually enforced rather than merely intended.
  --
  -- The `_required_` in two of the names is not decoration. Postgres auto-names
  -- a column-level CHECK `<table>_<column>_check`, so `constraint
  -- task_series_month_day_check` collides with the range check on the column
  -- itself and the migration aborts with 42710. Naming the cross-column rules
  -- after what they assert avoids the clash and reads better anyway.

  constraint task_series_monthly_mode_check check (
    (freq = 'monthly') = (month_mode is not null)
  ),

  constraint task_series_month_day_required_check check (
    case when month_mode = 'by_date'
         then month_day is not null
         else month_day is null
    end
  ),

  constraint task_series_nth_weekday_required_check check (
    case when month_mode = 'by_nth_weekday'
         then nth_week is not null and nth_weekday is not null
         else nth_week is null and nth_weekday is null
    end
  ),

  -- Weekdays belong to a weekly rule and nowhere else. Without this a series
  -- switched from weekly to daily keeps a BYDAY the expander ignores, and the
  -- stored `rrule` and the columns quietly stop describing the same thing.
  constraint task_series_weekly_days_check check (
    freq = 'weekly' or cardinality(byweekday) = 0
  ),

  constraint task_series_ends_check check (
    case ends_mode
      when 'never' then ends_on is null     and ends_count is null
      when 'on'    then ends_on is not null  and ends_count is null
      when 'after' then ends_count is not null and ends_on is null
    end
  ),

  -- A rule that ends before it starts names no dates at all, which is a typo
  -- rather than an intention.
  constraint task_series_ends_on_after_start_check check (
    ends_on is null or ends_on >= starts_on
  )
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
--
-- Every read is "my live series", so the index carries both halves of that
-- predicate: `user_id` leading because RLS adds it to every statement anyway,
-- and partial on `deleted_at is null` because a deleted series is only ever
-- reached by following an occurrence's `series_id`, never by listing.
create index task_series_user_live_idx
  on public.task_series (user_id)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

-- Reuses the generic function from 0002. There is no `sync_task_completed_at`
-- analogue here: a series is never done — its occurrences are.
create trigger task_series_touch_updated_at
  before update on public.task_series
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- Same shape as `task_occurrence` in 0004, and for the same reason: a series
-- carries a title and notes, which is task data, and acceptance criterion 6 says
-- an admin session reading task data gets nothing.
--
-- Note what is NOT here, in both directions:
--
--   * No escalation-guard trigger. That exists on `profiles` because it holds
--     `role` and `status`. `task_series` has no privileged column — every field
--     is the owner's to change — exactly like `task_occurrence`. Copying the
--     guard across would be cargo cult.
--
--   * No `revoke` block. 0004 killed the `alter default privileges` that was
--     handing `Dxtm` (crucially TRUNCATE, which does not consult RLS) to `anon`
--     and `authenticated` on every newly created table in this schema. This
--     table was created after that, so it starts with an empty ACL and holds
--     exactly what is granted below. That is the payoff 0004 predicted; the
--     regression guard for it lives in tests/integration/rls-boundary.test.ts.
--
--   * No mention of `deleted_at`. A policy answers "is this row yours"; deciding
--     which of your own rows are currently visible is the repo's job. Folding
--     the soft delete in here would mean re-reading the security policy every
--     time the application's idea of "visible" changed.

alter table public.task_series enable row level security;

grant select, insert, update, delete on public.task_series to authenticated;
grant all on public.task_series to service_role;
-- `anon` gets nothing. There is no publicly readable repeat rule.

-- `(select auth.uid())` rather than a bare `auth.uid()`, as in 0003 and 0004:
-- the scalar subquery is hoisted into an InitPlan and evaluated once per
-- statement instead of once per row.

create policy "task_series_select_own"
  on public.task_series
  for select
  to authenticated
  using (user_id = (select auth.uid()));

-- INSERT has no USING — there is no existing row to test. WITH CHECK is what
-- stops a caller creating a series owned by somebody else, which would plant a
-- recurring task in another person's list rather than merely reading one.
create policy "task_series_insert_own"
  on public.task_series
  for insert
  to authenticated
  with check (user_id = (select auth.uid()));

-- Both clauses, always. USING picks which rows may be targeted; WITH CHECK says
-- what they may look like afterwards. USING alone lets an owner re-point
-- `user_id` at another account and hand the series away.
create policy "task_series_update_own"
  on public.task_series
  for update
  to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- A DELETE policy even though the application soft-deletes. The row is the
-- owner's; the fact that the app currently prefers `deleted_at` is a product
-- decision, not a permission one, and a table whose owner cannot remove their
-- own row is a surprise waiting for whoever adds account cleanup.
create policy "task_series_delete_own"
  on public.task_series
  for delete
  to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- The two constraints 0004 deferred
-- ---------------------------------------------------------------------------
--
-- 0004 shipped `series_id uuid` with no FK and no unique index, deliberately, so
-- that no table and no policy set existed which nothing exercised. Every row
-- written in phase 2 has `series_id = NULL`, so both statements below apply
-- against data that trivially satisfies them.

alter table public.task_occurrence
  add constraint task_occurrence_series_fk
  foreign key (series_id) references public.task_series (id) on delete cascade;

-- `on delete cascade` is inert in normal operation — the application soft-
-- deletes a series and the row stays — but it is the honest answer for the case
-- where a series row really is removed (account cleanup, a manual fix), where
-- the alternative is occurrences pointing at nothing.

-- PARTIAL, and the `where` is load-bearing. Without it every one-off task would
-- share the key `(NULL, occurs_on)` — which NULLs would in fact keep distinct,
-- but only by relying on that; the predicate says the intent instead of
-- depending on it, and it keeps the index to the rows it is actually about.
--
-- What it buys: one occurrence per series per day, enforced by the database. It
-- is also what `materialize()` targets with ON CONFLICT, so first-touch is a
-- single statement that cannot lose a race to itself.
create unique index task_occurrence_series_day_uniq
  on public.task_occurrence (series_id, occurs_on)
  where series_id is not null;

-- Reads of a series' materialised rows go (series_id, occurs_on), which the
-- unique index above already serves.

comment on table public.task_series is
  'A repeat rule. Names dates; carries no status or progress — the trackable '
  'unit is still task_occurrence. Occurrences are materialised on first touch, '
  'never on read. Soft-deleted, so criterion 17 (untouched future goes, '
  'recorded history stays) needs no job. RLS scopes every row to its owner.';

comment on column public.task_series.rrule is
  'The columns above, serialised RFC 5545. Derived, never input — see '
  'src/lib/recurrence/serialize.ts. Exists so adopting the rrule package later '
  'is additive rather than a migration.';

comment on column public.task_series.deadline_time is
  'Wall-clock time of day, no zone. deadline_at is computed per occurrence by '
  'resolving (occurs_on + this) in the owner''s timezone, so 09:00 stays 09:00 '
  'local across a DST transition (criterion 20).';

comment on column public.task_series.byweekday is
  'RFC 5545 BYDAY codes. WEEKLY only. Empty means "the weekday starts_on falls '
  'on", per RFC 5545.';

comment on column public.task_series.deleted_at is
  'Soft delete. A deleted series is never expanded, so its untouched future '
  'occurrences disappear; its materialised rows survive untouched.';
