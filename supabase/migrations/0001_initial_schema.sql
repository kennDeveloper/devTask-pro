-- 0001_initial_schema.sql
--
-- The `profiles` table: devtask-pro's application-side record of a person.
--
-- WHY IT EXISTS AT ALL
-- Supabase owns `auth.users`, but that table belongs to the auth service and we do
-- not get to add columns to it. Everything the *app* needs to know about a person —
-- what timezone their "today" is measured in, whether they are an admin, and whether
-- an admin has let them in yet — lives here instead.
--
-- WHY `id` REFERENCES `auth.users(id)`
-- The profile is not a separate identity, it is the same identity seen from the app
-- side, so it reuses the auth user's uuid as its own primary key rather than minting
-- a fresh one. Three consequences, all wanted:
--   1. `auth.uid()` inside an RLS policy can be compared directly against
--      `profiles.id` — no join, no lookup table. See 0003.
--   2. There is no way to end up with a profile that has no auth user.
--   3. `on delete cascade` means deleting the auth user removes the profile with it.
-- The row itself is created by a trigger on `auth.users` insert — see 0002. Nothing
-- in application code inserts a profile.
--
-- NOTE ON SCOPE: there is deliberately NO `organisation_id` here. devtask-pro is a
-- per-user private tracker, not a multi-tenant product. The house schema guide's
-- org-scoping convention has no tenant to scope to and is intentionally dropped.

create table public.profiles (
  -- Same uuid as the auth user. Not generated here; supplied by the trigger in 0002.
  id            uuid primary key references auth.users (id) on delete cascade,

  -- Copied from auth.users at signup so the admin queue can list accounts without
  -- reaching into the auth schema. auth.users remains the source of truth for login.
  email         text not null,

  -- Optional; the user sets it in settings. Nothing depends on it being present.
  display_name  text,

  -- IANA zone name, e.g. 'Asia/Manila'. Every "is this overdue?" and "what is today?"
  -- question resolves against this, on the server and in the browser alike, so both
  -- sides agree and SSR does not flash a different day. 'UTC' is the safe default for
  -- a row created by a trigger, which has no browser to ask.
  timezone      text not null default 'UTC',

  -- Enums are text + CHECK by house convention: easier to extend than a pg enum type.
  -- 'member' can only ever see their own data; 'admin' governs access to the app and
  -- never sees task data (that is enforced by RLS, not by this column).
  role          text not null default 'member'
                  check (role in ('member', 'admin')),

  -- The access gate. A brand-new signup is 'pending' and can reach nothing but the
  -- /pending screen. An admin moves them to 'active' (in) or 'rejected' (never in);
  -- 'suspended' is a previously-active account switched back off.
  -- Read fresh on every request by the middleware, so a suspension bites immediately
  -- instead of waiting for an already-issued JWT to expire.
  status        text not null default 'pending'
                  check (status in ('pending', 'active', 'rejected', 'suspended')),

  -- Audit of the approval decision. Both stay null until an admin acts.
  approved_at   timestamptz,
  approved_by   uuid references public.profiles (id),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- The admin queue is "show me everyone awaiting a decision", i.e. a filter on status.
-- It is the only query in the app that reads across profiles rather than by primary key.
create index profiles_status_idx on public.profiles (status);

comment on table public.profiles is
  'App-side profile for an auth.users identity. One row per user, created by the '
  'handle_new_user trigger. Carries the access status the middleware gates on.';

comment on column public.profiles.status is
  'Access gate: pending -> /pending, rejected|suspended -> /no-access, active -> the app.';

comment on column public.profiles.role is
  'member or admin. Admins govern access only; RLS still hides every other user''s data from them.';
