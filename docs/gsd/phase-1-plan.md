# devtask-pro phase 1 — plan

> GSD stage 2 of 5 · [Discuss ✓] → **Plan** → Execute → Verify → Ship
> Input: `docs/gsd/devtask-pro-v1.md` · Mode: interactive
> Phase 1 of 6: **scaffold + auth + access gating + the RLS boundary**. No tasks yet.

## Goal

A running local app where the **access model is proven**: someone can sign up, confirm their email,
wait on `/pending`, be approved by a seeded admin, and reach `/today` — and where the RLS mechanism
that will later protect task data is demonstrated by a passing test, not asserted.

Phase 1 deliberately builds **no task features**. It exists to de-risk the one thing every later
phase sits on top of.

## Research findings (verified, not assumed)

Read from `lightning-kickoff/.claude/skills/scaffold-project/templates/`:

1. **`app/src/lib/db/client.ts` is a privileged connection.** A `postgres-js` singleton over
   `DATABASE_URL`, lazily initialised behind a Proxy so `next build` doesn't need the env var.
   It connects as the DB owner and therefore **bypasses RLS entirely**. Keep it — it is exactly
   right for the reminder job and admin ops — but it cannot serve user-facing task reads.
2. **Kickoff has no RLS precedent.** `grep -rniE 'rls|auth\.uid\(\)|request\.jwt'` across every skill
   and template returns 11 hits, all substrings of the word "URLs". There is no house pattern to
   lift. Task 3 invents it, and is sequenced early for that reason.
3. **`app/src/lib/trpc/server.ts` needs rewriting, not copying.** Its `buildContext` loads the
   profile through the privileged `db`, and its `Context`/`orgProcedure` are built around
   `organisationId`, which devtask-pro drops.
4. **Auth templates are magic-link.** `(auth)/sign-in/page.tsx` calls `signInWithOtp`. Admin-triggered
   password resets require password auth, so these pages are rewritten. The `(auth)/layout.tsx`
   chrome and `auth/callback/route.ts` PKCE exchange are both still liftable as-is.
5. **Migration convention** (`reference/SCHEMA_GUIDE.md`): uuid PKs `default gen_random_uuid()`,
   enums as `text` + `CHECK`, `created_at`/`updated_at timestamptz not null default now()` on every
   table, `users` mirrors `auth.users` by referencing `auth.users(id)`. `drizzle.config.ts` writes
   generated SQL to `./supabase/migrations`.
6. **Design tokens are a contract, not a file** (`app/src/app/globals.css.NOTE.md`). Every templated
   primitive references tokens by name — `ink, paper, paper-2, paper-3, accent, accent-deep,
   accent-soft, line, line-2, fg-2, fg-3, fg-4, trip, trip-soft, live` — plus the shadcn bridge vars.
   `globals.css` must be authored to satisfy it.
7. **CI** (`config/.github/workflows/ci.yml`): Node 22 + pnpm, placeholder env so `next build` can
   statically analyse without secrets, then typecheck → lint → build → test.
8. **Playwright**: `testDir: ./e2e`, chromium, `webServer: pnpm dev` with `reuseExistingServer`.

## Decisions taken at plan time

- **Password auth, not magic-link** — the admin password-reset requirement presupposes passwords.
  Magic-link is not additionally offered in v1; two auth paths means two recovery stories.
- **Email confirmation *then* admin approval** — two gates. Keeps unverified addresses out of the
  admin queue and guarantees a reset email targets a proven address.
- **`src/lib/db/client.ts` splits in two.** `dbAdmin` (privileged, existing template code, renamed to
  make misuse loud) and `withUser()` (RLS-scoped, new). No module exports a bare `db` — the name that
  invites an unscoped query is deleted outright.
- **First admin via an idempotent script, not `seed.sql`** — `pnpm admin:create` uses the service-role
  admin API (`auth.admin.createUser` with `email_confirm: true`), then promotes the profile. Works
  identically against local and cloud; raw SQL inserts into `auth.users` do not.
- **Gate screens live in their own `(gate)` route group** — `/pending` and `/no-access` need the auth
  chrome but must not sit behind the `(app)` guard that would bounce them into a redirect loop.
- **Access predicates live in `src/lib/access/`**, not `src/lib/auth/` — keeps them off the same files
  as the auth pages so tasks 6 and 7 stay parallel-safe.

## Tasks

Each is sized for one fresh context window. `[seq]` must follow its predecessor; tasks sharing a
wave touch disjoint files and are parallel-safe.

### Wave 0

**1 · Scaffold the app and repo skeleton** `[seq]`
- **Files:** `package.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`,
  `postcss.config.mjs`, `vitest.config.ts`, `tests/setup.ts`, `playwright.config.ts`,
  `drizzle.config.ts`, `.gitignore`, `.nvmrc`, `.env.local`, `.env.example`,
  `.github/workflows/ci.yml`, `components.json`
- **Pattern:** `scaffold-nextjs-app/SKILL.md` steps 2–5; configs copied from
  `templates/config/*` and `templates/env/.env.local.template`; scripts merged from
  `templates/config/package.scripts.json`.
- **Do:** `pnpm create next-app@^16 . --ts --tailwind --app --import-alias '@/*' --no-eslint
  --use-pnpm --skip-install` (into the existing dir — `docs/` is not in create-next-app's conflict
  list, but verify before running and scaffold to a temp dir and merge if it objects).
  Then `pnpm add @trpc/server @trpc/client @trpc/react-query @tanstack/react-query zod
  @supabase/supabase-js @supabase/ssr drizzle-orm postgres` and
  `pnpm add -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom
  drizzle-kit @playwright/test tsx`, then `pnpm dlx shadcn@latest init --base-color slate --yes`.
  `git init`, branch `phase-1-foundation`.
- **Critical:** rewrite `"build"` to plain `next build`. `create-next-app@16` ships
  `--experimental-build-mode compile`, which 500s every SSR page in production with
  `ReferenceError: __dirname is not defined`.
- **Output:** an app that builds and serves a default page; `pnpm typecheck && pnpm lint &&
  pnpm build && pnpm test` all green on an empty test suite (`passWithNoTests: true`).
- **Check:** all four gate commands exit 0; `pnpm dev` serves `localhost:3000`; `git log` shows one
  commit.

### Wave 1 — tasks 2 and 4 are parallel-safe (disjoint files)

**2 · Supabase local stack, `profiles` schema, RLS policies** `[seq after 1]`
- **Files:** `supabase/config.toml`, `src/lib/db/schema.ts`,
  `supabase/migrations/<ts>_initial.sql`, `scripts/create-admin.ts`
- **Pattern:** `templates/supabase/config.toml` for the port base;
  `reference/SCHEMA_GUIDE.md` for DDL conventions.
- **Build:** `profiles` — `id uuid pk references auth.users(id) on delete cascade`, `email text not
  null`, `display_name text`, `timezone text not null default 'UTC'`,
  `role text not null default 'member' check (role in ('member','admin'))`,
  `status text not null default 'pending' check (status in
  ('pending','active','rejected','suspended'))`, `approved_at`, `approved_by uuid references
  profiles(id)`, `created_at`, `updated_at`.
  Plus: a `security definer` trigger on `auth.users` insert that mirrors the new user into
  `profiles`; an `updated_at` touch trigger; `alter table profiles enable row level security`; and
  policies `select`/`update` `using (id = auth.uid())`. The update policy must use a `with check`
  that **forbids self-editing `role` and `status`** — otherwise a pending user promotes themselves
  to an active admin.
- **Output:** `pnpm db:reset` applies cleanly; `pnpm admin:create` is idempotent and yields one
  `role='admin', status='active'` profile.
- **Check:** integration test — signing up a user via the anon client produces exactly one matching
  `profiles` row with `status='pending'` and `role='member'`; a direct `update profiles set
  role='admin'` through that user's own session is **rejected**.

**4 · Design tokens and UI primitives** `[parallel with 2, after 1]`
- **Files:** `src/app/globals.css`, `src/components/ui/{button,card,input,field,badge,separator,
  skeleton,table,tabs,text}.tsx`, `src/components/brand/logo.tsx`, `src/lib/utils.ts`
- **Pattern:** copy the primitives verbatim from `templates/app/src/components/ui/*`; author
  `globals.css` to the full contract in `templates/app/src/app/globals.css.NOTE.md`.
- **Palette:** flat clean-white — white surfaces, charcoal ink, a single accent. No gradients, no
  heavy shadows. Both `:root` and `.dark` must define every token.
- **Output:** every token in the contract is defined in both modes; primitives compile and reference
  tokens by name, never a hex value.
- **Check:** a Vitest render of `<Button>`/`<Card>` mounts without error; `grep -E '#[0-9a-fA-F]{3,6}'
  src/components/` returns nothing.

### Wave 2

**3 · The RLS-scoped Drizzle client** `[seq after 2]` — **highest risk in the phase**
- **Files:** `src/lib/db/client.ts` (rewrite), `src/lib/db/rls.ts`, `src/lib/db/rls.test.ts`,
  `tests/integration/rls-boundary.test.ts`
- **Pattern:** none in-repo — this is new. Build on the template's lazy-Proxy singleton for the
  privileged connection; keep `postgres(url, { prepare: false })` (required for pooler
  compatibility).
- **Build:**
  - `dbAdmin` — the privileged connection, renamed from `db` so every use site reads as a
    deliberate escalation. Its doc comment names the only two legitimate callers: the reminder job
    and admin account operations.
  - `withUser(accessToken, fn)` — opens a transaction and, before running `fn`, issues
    `select set_config('request.jwt.claims', <claims json>, true)` and `set local role authenticated`.
    Both are `LOCAL`, so they unwind on commit or rollback and cannot leak into the next borrower of
    a pooled connection. `fn` receives the transaction handle; there is no way to get a scoped query
    without going through it.
- **Output:** the only exports are `dbAdmin` and `withUser`. **No module exports a bare `db`.**
- **Check:** integration test against the local stack, with two real users A and B —
  (a) `withUser(A)` selecting `profiles` returns exactly A's row;
  (b) `withUser(B)` cannot see A's row;
  (c) `withUser(<admin>)` cannot see A's row either — role does not defeat RLS;
  (d) `dbAdmin` **can** see both, proving the escalation path still works;
  (e) after a `withUser` call throws, the next query on the same pooled connection is unscoped
      again — i.e. `set local` genuinely unwound.
- **Note on brief criterion 6:** it says an admin session reading a *task table* returns zero rows.
  Task tables do not exist until phase 2, so phase 1 proves the **mechanism** on `profiles` and
  leaves behind the two-user harness that phase 2 re-points at `task_occurrence`. Criterion 6 stays
  open in the verify checklist until then — it is not silently marked done.

### Wave 3 — tasks 5, 6, 7 are parallel-safe (disjoint files)

**5 · tRPC wiring** `[after 3]`
- **Files:** `src/lib/trpc/server.ts`, `src/lib/trpc/client.tsx`, `src/lib/trpc/routers/_app.ts`,
  `src/lib/trpc/routers/profile.ts`, `src/app/api/trpc/[trpc]/route.ts`, `src/app/layout.tsx`
- **Pattern:** `templates/app/src/lib/trpc/*`, with the org machinery removed.
- **Build:** `Context` = `{ supabase, user, accessToken, profile }`. Drop `organisationId` and
  `orgProcedure`. Procedures: `publicProcedure` → `protectedProcedure` (authenticated) →
  `activeProcedure` (`status === 'active'`) → `adminProcedure` (`role === 'admin'`).
  `buildContext` loads the profile through `withUser`, not `dbAdmin`.
  `profile.get` / `profile.updateTimezone` are the first two procedures.
- **Output:** a typed `AppRouter`; `TRPCProvider` mounted in the root layout.
- **Check:** unit tests via `createCallerFactory` — anonymous ctx on `protectedProcedure` throws
  `UNAUTHORIZED`; `status='pending'` on `activeProcedure` throws `FORBIDDEN`; `role='member'` on
  `adminProcedure` throws `FORBIDDEN`.

**6 · Password auth pages** `[after 4]`
- **Files:** `src/app/(auth)/layout.tsx`, `src/app/(auth)/{sign-in,sign-up,forgot-password,
  reset-password}/page.tsx`, `src/app/auth/callback/route.ts`, `src/lib/auth/redirect.ts`,
  `src/lib/auth/validators.ts`
- **Pattern:** `(auth)/layout.tsx` and `auth/callback/route.ts` lift verbatim; the pages are
  rewritten from `signInWithOtp` to `signInWithPassword` / `signUp` / `resetPasswordForEmail` /
  `updateUser`.
- **Build:** Zod schemas in `validators.ts` (email shape, password min length) — validation is a
  pure exported function, never inline in JSX. Sign-up renders a "check your inbox" confirmation
  state. `authCallbackUrl()` keeps its `NEXT_PUBLIC_SITE_URL` preference so confirmation mail never
  points at localhost from a deployed environment. Change the callback's default `next` from the
  template's `/projects` to `/today`.
- **Output:** four working pages using only design tokens and the primitives from task 4.
- **Check:** Vitest — validators reject a bad email, a short password, and a mismatched
  confirmation; each form renders its error and its pending/spinner state.

**7 · Middleware gating and gate screens** `[after 3, 4]`
- **Files:** `src/middleware.ts`, `src/lib/access/{status-route,status-route.test}.ts`,
  `src/app/(gate)/{pending,no-access}/page.tsx`
- **Pattern:** extend `templates/app/src/middleware.ts` — keep its cookie/`getUser()` block
  **exactly as written**; the "do not run code between `createServerClient` and `getUser()`" comment
  is load-bearing.
- **Build:** after `getUser()`, read the caller's own `profiles` row through the request-scoped
  Supabase client (RLS makes this safe), then route on status via a **pure**
  `routeForStatus(status, pathname)` helper: `pending → /pending`, `rejected|suspended →
  /no-access`, `active → through`, no profile → `/sign-in`. The helper must let `(auth)` and
  `(gate)` paths through unconditionally or it redirect-loops.
- **Why middleware must hit the row, not the JWT:** suspending a user does not invalidate an
  already-issued access token. Reading `profiles.status` on each request is what makes suspension
  bite immediately (brief criterion 4); the Supabase ban applied by the admin tier in phase 5 only
  prevents them obtaining a *new* token.
- **Output:** every route reachable only from the correct account status.
- **Check:** `routeForStatus` is exhaustively unit-tested over the status × path-group matrix
  including the loop-avoidance cases; e2e in task 9 proves it end-to-end.

### Wave 4

**8 · App shell, `/today` placeholder, settings** `[after 4, 5, 7]`
- **Files:** `src/app/(app)/layout.tsx`, `src/app/(app)/today/page.tsx`,
  `src/app/(app)/settings/page.tsx`, `src/components/dashboard/*`, `src/app/(marketing)/page.tsx`
- **Pattern:** `templates/app/src/components/dashboard/*` — `DashboardShell`, `Sidebar`, `Topbar`,
  `nav-config`, the sidebar/search contexts.
- **Build:** nav trimmed to Today / Tasks / Overdue / Settings, with the three unbuilt entries
  visibly disabled rather than 404-ing. `/today` shows an empty state naming what phase 2 adds.
  Settings holds display name and the timezone picker, detecting
  `Intl.DateTimeFormat().resolvedOptions().timeZone` as its default.
- **Output:** signed-in navigable chrome, responsive.
- **Check:** timezone save round-trips through `profile.updateTimezone` and survives reload; shell
  renders at 375px with no horizontal scroll; loading states are skeletons mirroring real layout.

### Wave 5

**9 · End-to-end proof and full gate run** `[after all]`
- **Files:** `e2e/auth-flow.spec.ts`, `e2e/screenshots.spec.ts`, `docs/LOCAL_DEV.md`, `CLAUDE.md`
- **Pattern:** `templates/config/e2e/screenshots.spec.ts`; `templates/docs/*.template`.
- **Build:** the full journey as one spec — sign up → confirm (via the local Inbucket mail catcher
  on the stack's mail port) → land on `/pending` → approve by direct DB write (the admin *UI* is
  phase 5) → reach `/today`. Plus screenshots of every route at desktop and mobile widths.
- **Output:** a repo `CLAUDE.md` recording the conventions this phase actually established —
  especially the `dbAdmin` / `withUser` split and its rule.
- **Check:** `pnpm test:e2e` green; all four gates green; brief criteria 1, 2, 3, 5, 7 (partial —
  reset-by-user, not yet by admin), 18, 19 demonstrably pass.

## Verify gates

From `lightning-kickoff/CLAUDE.md` — not guessed:

```
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

Plus, for this phase specifically: `pnpm test:e2e` with the local stack up (`pnpm db:start`).

## Branch / PR target

Branch `phase-1-foundation` → PR into `main`. **The session never merges.** No GitHub remote exists
yet — creating it is a Ship-stage decision, and `gsd-ship` will need one before it can open a PR.

## Risks & rollbacks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **`set local role authenticated` fails or leaks across pooled connections.** The core mechanism, with no in-house precedent. | Medium | Task 3 is sequenced third, before anything depends on it, and its check includes an explicit leak test (e). If it can't be made to hold, fall back to routing user reads through `supabase-js`/PostgREST — slower and a second query dialect, but RLS applies by construction. Decide before wave 3 starts. |
| **`create-next-app` refuses to scaffold into a dir containing `docs/`.** | Low | Scaffold to a temp dir and merge. Checked at the top of task 1, not discovered at the end. |
| **Middleware reading `profiles` on every request adds latency.** One DB round-trip per navigation. | Medium | Accepted for phase 1 — correctness first, and criterion 4 requires it. If it hurts, cache status in a short-TTL signed cookie invalidated on admin action. Do not "optimise" by trusting the JWT; that reintroduces the suspension delay. |
| **Local stack needs Docker.** `supabase start` won't run without it. | Low | Verify in task 1 and fail loudly with a clear message rather than midway through task 2. |
| **Email confirmation in local dev.** Real mail isn't sent. | Low | The local stack ships Inbucket; task 9's e2e reads the confirmation link from it. |

**Rollback:** every task is one atomic commit on `phase-1-foundation`. Nothing is deployed and no
cloud resource is created, so rollback is `git reset` — the reason for choosing local-only.

## Deferred to later phases

- Task tables, the recurrence engine, tags, search, reminders (phases 2–4, 6).
- The admin UI — approve/reject/suspend/reset (phase 5). Phase 1 approves by direct DB write.
- Cloud provisioning: GitHub repo, Supabase project, Vercel (first ship).
- Whether `(admin)` shares `DashboardShell` or gets a deliberately sparse shell (phase 5).
