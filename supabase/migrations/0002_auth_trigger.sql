-- 0002_auth_trigger.sql
--
-- Two triggers. The first keeps `public.profiles` in step with `auth.users`; the
-- second keeps `updated_at` honest.

-- ---------------------------------------------------------------------------
-- 1. handle_new_user() — mirror every new auth user into public.profiles
-- ---------------------------------------------------------------------------
--
-- WHY A TRIGGER AND NOT APPLICATION CODE
-- A profile row must exist for *every* auth user, no exceptions — the middleware
-- treats "no profile" as "not signed in" and bounces the request. Users can appear
-- through several doors (the sign-up form, `auth.admin.createUser` in
-- scripts/create-admin.ts, an invite, the Studio UI), and only the database sees
-- all of them. Putting the insert in the sign-up handler would leave every other
-- door creating an auth user with no profile.
--
-- WHY `security definer`
-- The function runs during an INSERT performed by the auth service (the `supabase_auth_admin`
-- role), which has no rights on `public.profiles`, and RLS is on that table (0003).
-- `security definer` makes the body execute as the function's owner (the `postgres`
-- superuser), which both owns the table and is exempt from RLS. This is the standard
-- Supabase pattern and the reason no user-facing INSERT policy is needed in 0003.
--
-- WHY `set search_path = ''`
-- `security definer` + a mutable search_path is a privilege-escalation footgun: anyone
-- who can create a schema earlier in the resolution order can shadow `profiles` with
-- their own table and have this superuser-owned function write to it instead. Pinning
-- search_path to empty forces every name in the body to be schema-qualified — which is
-- why `public.profiles` below is spelled out in full. Do not "tidy" that away.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, role, status)
  values (
    new.id,
    new.email,
    'member',   -- explicit rather than leaning on the column default: the two values
    'pending'   -- that decide what a new account can do are worth reading here.
  )
  -- Makes the trigger re-runnable. If a profile already exists for this id — a
  -- replayed insert, a re-created auth user, a migration applied over live data —
  -- leave the existing row alone rather than failing the auth insert. A failure here
  -- would roll back the signup itself.
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT on auth.users: creates the matching public.profiles row as pending/member.';

-- AFTER INSERT, not BEFORE: the auth.users row must be committed-visible before the
-- profiles FK to auth.users(id) can be satisfied.
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. touch_updated_at() — maintain updated_at on public.profiles
-- ---------------------------------------------------------------------------
--
-- `default now()` only fires on INSERT. Without this, updated_at would record the
-- creation time forever. BEFORE UPDATE so the new value is written as part of the
-- same row write rather than costing a second one.
--
-- No `security definer` here: this one runs as whoever is doing the UPDATE, which is
-- exactly right — it needs no privileges the caller does not already have.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'BEFORE UPDATE row trigger: stamps updated_at = now() on every write.';

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row
  execute function public.touch_updated_at();
