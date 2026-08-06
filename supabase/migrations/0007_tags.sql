-- 0007_tags.sql
--
-- `tags`, and the two join tables that attach them to a series (as a template)
-- and to an occurrence (as the actual thing).
--
-- NUMBERING: 0006 belongs to phase 5, which is being built on its own branch off
-- `main`. This phase is stacked on phase 3, so 0006 is simply absent from this
-- branch's history until the two merge. Migrations order lexicographically, so a
-- gap is a gap and not a hole.
--
-- WHY A TAG IS ATTACHED IN TWO PLACES
-- A series' tags are a *template*, exactly like its title and its deadline time:
-- they describe what its occurrences should look like, and they are copied onto
-- an occurrence the moment it materialises. An occurrence's tags are then its
-- own, and editing the series afterwards does not reach back and change them.
-- That is the same rule every other series field follows (0005), and it is what
-- makes "tag the whole series" and "tag just today's" both expressible.
--
-- WHY THE JOIN TABLES CARRY `user_id`
-- So RLS can scope them with the same one-line policy as every other table. The
-- alternative is a policy that runs `exists (select 1 from task_occurrence ...)`
-- on every row — a policy that reads another table, which is both slower and the
-- shape that eventually recurses (see the long note in 0003).
--
-- ===========================================================================
-- THE PART THAT IS ACTUALLY SECURITY-RELEVANT: COMPOSITE FOREIGN KEYS
-- ===========================================================================
--
-- A foreign key check does **not** consult row level security. It runs as a
-- system-internal read, and it can see rows the caller cannot.
--
-- So the obvious design — `occurrence_id references task_occurrence(id)`,
-- `tag_id references tags(id)`, `user_id` filled in by the policy — has a hole.
-- A signed-in user can insert:
--
--     (user_id = me, occurrence_id = <somebody else's task>, tag_id = <my tag>)
--
-- The insert policy is satisfied (`user_id = auth.uid()`), both FKs resolve, and
-- the row is written into another person's data. It leaks nothing *readable* —
-- they still cannot select that task — but they can now write rows that another
-- account's queries will join against, which is not a property this application
-- should have.
--
-- The fix is to make the FK carry the owner: reference **both** columns at once,
-- against a `unique (id, user_id)` on the parent. Then "this link, this tag and
-- this task all belong to the same person" is a thing the database enforces on
-- every insert and update, and no policy has to be trusted to do it.

-- ---------------------------------------------------------------------------
-- The unique keys the composite FKs point at
-- ---------------------------------------------------------------------------
--
-- Redundant as *keys* — `id` is already unique on its own — and that is fine.
-- They exist so `(id, user_id)` is a referenceable target. Postgres requires a
-- unique constraint covering exactly the referenced columns; it will not infer
-- one from the primary key plus a NOT NULL.

alter table public.task_series
  add constraint task_series_id_user_key unique (id, user_id);

alter table public.task_occurrence
  add constraint task_occurrence_id_user_key unique (id, user_id);

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------

create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,

  name       text not null check (length(btrim(name)) between 1 and 40),

  -- A `Badge` tone name, not a colour. `AGENTS.md` forbids raw hex under
  -- `src/components/**`; storing one here would smuggle it in through the
  -- database instead, where the dark theme cannot adjust it. These six are the
  -- tones `src/components/ui/badge.tsx` actually implements.
  color      text not null default 'neutral'
               check (color in ('neutral', 'info', 'success', 'warning', 'danger', 'default')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Referenced by both join tables. See the header.
  constraint tags_id_user_key unique (id, user_id)
);

-- One "work" per person, however they capitalised it the second time.
--
-- A functional index rather than a `citext` column: it needs no extension, it is
-- the thing the uniqueness rule actually says, and `lower()` is immutable so the
-- index is safe. Zod normalises the same way at the boundary so the user gets a
-- sentence rather than a constraint name — but this is the boundary.
create unique index tags_user_name_uniq
  on public.tags (user_id, lower(btrim(name)));

create index tags_user_idx on public.tags (user_id);

create trigger tags_touch_updated_at
  before update on public.tags
  for each row
  execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- series_tags — the template
-- ---------------------------------------------------------------------------

create table public.series_tags (
  user_id   uuid not null,
  series_id uuid not null,
  tag_id    uuid not null,

  primary key (series_id, tag_id),

  -- Both composite. Neither the series nor the tag can belong to anybody but the
  -- owner named on this row.
  constraint series_tags_series_fk
    foreign key (series_id, user_id) references public.task_series (id, user_id)
    on delete cascade,
  constraint series_tags_tag_fk
    foreign key (tag_id, user_id) references public.tags (id, user_id)
    on delete cascade
);

-- The reverse lookup: "which series carry this tag", for the filter.
create index series_tags_tag_idx on public.series_tags (tag_id);
create index series_tags_user_idx on public.series_tags (user_id);

-- ---------------------------------------------------------------------------
-- occurrence_tags — the actual
-- ---------------------------------------------------------------------------

create table public.occurrence_tags (
  user_id       uuid not null,
  occurrence_id uuid not null,
  tag_id        uuid not null,

  primary key (occurrence_id, tag_id),

  constraint occurrence_tags_occurrence_fk
    foreign key (occurrence_id, user_id) references public.task_occurrence (id, user_id)
    on delete cascade,
  constraint occurrence_tags_tag_fk
    foreign key (tag_id, user_id) references public.tags (id, user_id)
    on delete cascade
);

create index occurrence_tags_tag_idx on public.occurrence_tags (tag_id);
create index occurrence_tags_user_idx on public.occurrence_tags (user_id);

-- `on delete cascade` on all four FKs is what makes acceptance criterion 3 a
-- property of the schema: deleting a tag removes its links and touches no task,
-- because the cascade runs from `tags` to the join row and stops there.

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- Same shape as 0004 and 0005: all four policies per table, `with check` on both
-- insert and update, `(select auth.uid())` so the planner hoists it, and no
-- escalation-guard trigger — none of these tables has a privileged column.
--
-- No `revoke` block: 0004 killed the `alter default privileges` that used to hand
-- TRUNCATE to `anon` and `authenticated` on every new table in this schema, so
-- tables created after it start with an empty ACL and hold exactly what is
-- granted below.

alter table public.tags            enable row level security;
alter table public.series_tags     enable row level security;
alter table public.occurrence_tags enable row level security;

grant select, insert, update, delete on public.tags            to authenticated;
grant select, insert, update, delete on public.series_tags     to authenticated;
grant select, insert, update, delete on public.occurrence_tags to authenticated;

grant all on public.tags            to service_role;
grant all on public.series_tags     to service_role;
grant all on public.occurrence_tags to service_role;
-- `anon` gets nothing. There is no publicly readable tag.

create policy "tags_select_own" on public.tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "tags_insert_own" on public.tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "tags_update_own" on public.tags
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "tags_delete_own" on public.tags
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "series_tags_select_own" on public.series_tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "series_tags_insert_own" on public.series_tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "series_tags_update_own" on public.series_tags
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "series_tags_delete_own" on public.series_tags
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "occurrence_tags_select_own" on public.occurrence_tags
  for select to authenticated using (user_id = (select auth.uid()));
create policy "occurrence_tags_insert_own" on public.occurrence_tags
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "occurrence_tags_update_own" on public.occurrence_tags
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "occurrence_tags_delete_own" on public.occurrence_tags
  for delete to authenticated using (user_id = (select auth.uid()));

comment on table public.tags is
  'User-defined labels. Unique per user case-insensitively (tags_user_name_uniq). '
  '`color` is a Badge tone name, never a hex — the dark theme has to be able to '
  'adjust it.';

comment on table public.series_tags is
  'A series'' template tags. Copied onto an occurrence when it materialises; '
  'editing them afterwards does not reach back into occurrences that already exist.';

comment on table public.occurrence_tags is
  'An occurrence''s own tags. Seeded from its series at materialisation, then '
  'independent — the same rule every other series field follows.';
