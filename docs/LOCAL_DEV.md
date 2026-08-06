# devtask-pro — local development

Everything runs locally. No cloud account is needed and none is used: there is no GitHub remote,
no Supabase cloud project, and no Vercel deployment yet. That is deliberate — see
`docs/gsd/phase-1-plan.md`.

## Prerequisites

- **Node 22** (`.nvmrc`) and **pnpm 11**
- **Docker**, running — the local Supabase stack will not start without it
- **Supabase CLI** 2.111 or newer

## First run

```bash
pnpm install
pnpm db:start          # first run pulls images; takes a few minutes
pnpm admin:create      # bootstrap the admin account
pnpm dev               # http://localhost:3000
```

`pnpm db:start` prints the real keys and ports. If they differ from `.env.local`, the printed values
win — copy them across.

## Ports

This project uses a `5442x` base so it can coexist with other local Supabase stacks.

| Service | URL |
| --- | --- |
| App | http://localhost:3000 |
| Supabase API | http://127.0.0.1:54421 |
| Postgres | `postgresql://postgres:postgres@127.0.0.1:54422/postgres` |
| Studio | http://127.0.0.1:54423 |
| Mailpit (all outbound mail) | http://127.0.0.1:54424 |

**No mail leaves your machine.** Confirmation and password-reset messages land in Mailpit — open it
in a browser and click the link there.

## Accounts

Email confirmation is on **and** an admin must approve the account, so a fresh signup passes through
two gates:

```
sign up → confirm via Mailpit → /pending → an admin approves → /today
```

`pnpm admin:create` creates a confirmed, active admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in
`.env.local`. It is idempotent — re-running is a no-op, not an error.

The admin **UI** does not exist until phase 5. To approve someone now, change their status directly
in Studio or via psql:

```sql
update public.profiles set status = 'active', approved_at = now() where email = '…';
```

That works from psql or Studio because those connect without a JWT. **The same statement from the
account holder's own session is rejected** by the guard in `0003_rls_policies.sql` — a user cannot
approve themselves. If you try it in the app and it fails, that is the feature working.

## Tests

```bash
pnpm test              # unit — no database needed, this is what CI runs
pnpm test:integration  # needs `pnpm db:start`; where the RLS boundary is proven
pnpm test:e2e          # Playwright; needs the stack and starts the dev server itself
```

Integration specs are deliberately out of `pnpm test` so CI stays green without a database. **Run
them whenever you touch data access** — they are the only thing that proves an admin cannot read
another person's rows.

Playwright writes screenshots of every route, in both themes, at desktop and mobile widths, to
`test-results/`. Worth actually looking at after a UI change.

## Gates

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

All four must pass before a PR. CI runs exactly these on Node 22.

## Database changes

Migrations in `supabase/migrations/` are **hand-written and numbered**, and they are the source of
truth. `src/lib/db/schema.ts` is a typed mirror you update by hand to match.

Do not author DDL with `drizzle-kit generate` — it cannot express the `security definer` trigger or
the RLS policies, which are the parts most worth reviewing.

Two things every new table needs, or the access model quietly breaks:

1. **Explicit `GRANT`s.** Supabase no longer auto-exposes new `public` tables. Without a grant,
   correct policies fail with *permission denied* rather than returning zero rows — which looks like
   a broken policy and is not one.
2. **RLS enabled plus an ownership policy**, following the shape in `0003_rls_policies.sql`.

Apply with `pnpm db:reset` (rebuilds from scratch — you will lose local data and need
`pnpm admin:create` again).

**Editing `supabase/config.toml` needs a restart**, not a reset: `supabase stop && pnpm db:start`.
Config is read at container start, so a change to auth settings appears to do nothing until you
cycle the stack.

## Gotchas already paid for

- **ESLint stays on 9.x.** ESLint 10 breaks `eslint-plugin-react`, which `eslint-config-next` needs.
- **pnpm build permissions live in `pnpm-workspace.yaml`** (`allowBuilds`) — pnpm 11 ignores
  `pnpm.onlyBuiltDependencies` in `package.json`, and without it esbuild never builds and vitest
  cannot run.
- **`src/proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention; proxy defaults to the
  Node.js runtime and setting `runtime` throws.
- **The local mail rate limit is raised to 200/hour** in `config.toml`. The default of 2/hour caps a
  test run at two signups. Do not copy that value to cloud.
