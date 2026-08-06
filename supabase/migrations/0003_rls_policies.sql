-- 0003_rls_policies.sql
--
-- Row Level Security for public.profiles.
--
-- The rule this file enforces, in one sentence: a signed-in user can read and edit
-- exactly their own profile row, and cannot promote themselves.
--
-- This is the file to read first when auditing devtask-pro's access model. Every
-- later table will follow the same shape, and the escalation guard at the bottom is
-- the single most security-relevant thing in phase 1.

alter table public.profiles enable row level security;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
--
-- RLS narrows what a role can reach; it does not grant anything. Recent Supabase CLI
-- versions no longer auto-expose newly created public tables to the Data API roles
-- (see `auto_expose_new_tables` in config.toml), so without these GRANTs the policies
-- below would be unreachable and every query would fail on permission, not on RLS.
--
-- `authenticated` gets select + update only. No insert (the trigger in 0002 creates
-- the row as definer) and no delete (accounts are removed through auth, which cascades).
-- `anon` gets nothing: there is no such thing as a publicly readable profile.
grant select, update on public.profiles to authenticated;
grant all on public.profiles to service_role;

-- ---------------------------------------------------------------------------
-- Policy: read your own row
-- ---------------------------------------------------------------------------
--
-- `(select auth.uid())` rather than a bare `auth.uid()` is deliberate. Wrapping it in
-- a scalar subquery lets the planner hoist it into an InitPlan and evaluate it once
-- per statement instead of once per row. Same semantics, materially cheaper — and the
-- middleware runs this query on every single request.
create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Policy: update your own row
-- ---------------------------------------------------------------------------
--
-- USING decides which rows you may target. WITH CHECK decides what the row is allowed
-- to look like afterwards; here it stops you re-pointing your row's `id` at somebody
-- else's uuid. It does NOT — and cannot — police `role` and `status`. See below.
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No INSERT policy: profiles are created by public.handle_new_user() in 0002, which is
-- `security definer` and therefore bypasses RLS. Users never insert their own profile.
-- No DELETE policy: deletion happens via auth.users, and the FK cascades.

-- ---------------------------------------------------------------------------
-- THE ESCALATION GUARD  <-- the important part
-- ---------------------------------------------------------------------------
--
-- THE HOLE THIS CLOSES
-- `profiles_update_own` above lets you write to your own row. Your own row contains
-- `role` and `status`. So, on its own, that policy lets a brand-new pending signup run
--
--     update profiles set role = 'admin', status = 'active' where id = auth.uid();
--
-- ...and walk straight past both gates. The policy has no objection: it is still your
-- row. Approval would be self-service.
--
-- WHY NOT FIX IT IN THE POLICY
-- The obvious fix is a WITH CHECK that compares the new role/status against the stored
-- ones — something like `role = (select role from public.profiles where id = ...)`.
-- Do not do this. A policy on `profiles` that queries `profiles` re-enters RLS on the
-- same table and recurses; Postgres aborts with `infinite recursion detected in policy
-- for relation "profiles"`. This is the classic Supabase RLS trap and the reason the
-- guard lives in a trigger instead.
--
-- A trigger also has something a policy does not: OLD. It can compare the row before
-- and after and object to the *change* rather than to the value, which is exactly the
-- rule we want — "you may not move your own role or status", not "your role must be X".
--
-- WHY THE PREDICATE IS `auth.uid() = old.id` AND NOT A ROLE CHECK
-- Admin and service operations are the ones that legitimately move role and status,
-- and they are distinguishable from the account holder by a property that is awkward
-- to forge: they carry no JWT subject.
--   * A user acting on themselves    -> auth.uid() is their uuid, equal to old.id -> BLOCKED
--   * `service_role` via PostgREST   -> the token has a role claim but no `sub`,
--                                       so auth.uid() is null -> null = old.id is
--                                       null, not true -> allowed
--   * A direct DB connection (dbAdmin, migrations, psql, the reminder job)
--                                    -> `request.jwt.claims` was never set, so
--                                       auth.uid() is null -> allowed
--   * One user editing another's row -> already impossible; RLS rejected it upstream.
-- Note the deliberate consequence: even an account holder whose role is *already*
-- 'admin' cannot change their own role or status through a normal session. Admins
-- administer other people, through the service-role path. Nobody edits their own gate.
--
-- `is distinct from` rather than `<>` so a null on either side still compares correctly
-- and does not silently evaluate to null (= not blocked).
create or replace function public.guard_profile_privileged_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() = old.id
     and (new.role is distinct from old.role
          or new.status is distinct from old.status)
  then
    raise exception 'role and status cannot be changed by the account holder'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function public.guard_profile_privileged_columns() is
  'BEFORE UPDATE on profiles: blocks self-promotion. A caller whose auth.uid() equals '
  'the row being updated may not move role or status. Admin/service paths carry no JWT '
  'subject, so auth.uid() is null and they pass. Lives in a trigger, not a WITH CHECK, '
  'because a policy that queries its own table recurses.';

create trigger profiles_guard_privileged_columns
  before update on public.profiles
  for each row
  execute function public.guard_profile_privileged_columns();
