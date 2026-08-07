<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# devtask-pro — codebase context

A private daily task tracker. Every user manages their own work; **nobody sees anybody else's
tasks, including admins**. One-off tasks with optional deadlines, plus recurring tasks driven by
Google-Calendar-style repeat rules. Tasks move `Todo → In Progress → Done`, carry a manually-set
progress percentage, and anything past its deadline surfaces in a derived **Overdue** bucket. A
separate **Admin** tier governs access — approve/reject signups, suspend accounts, trigger password
resets — and never sees task data.

Planning lives in `docs/gsd/`. Read `devtask-pro-v1.md` (the decisions and their rationale) before
changing anything architectural; it is the record of what was decided and why, and re-deciding
without reading it wastes the discussion that produced it.

## Stack

Next.js 16 (App Router) + React 19 · tRPC 11 · Drizzle over Supabase Postgres · Supabase Auth
(`@supabase/ssr`) · Tailwind v4 + shadcn/ui primitives · Zod 4 · Vitest + Testing Library ·
Playwright · `next-themes` · pnpm 11, Node 22.

**Not multi-tenant.** The lightning-kickoff scaffold this derives from generates org-scoped tables;
devtask-pro deliberately has no `organisation_id`. Rows are owned by a person, scoped on `user_id`.

## The access model — read this before touching data access

This is the one part of the codebase where a plausible-looking change can quietly remove a security
guarantee.

**Two database paths, and they are not interchangeable:**

- **`withUser(claims, fn)`** (`src/lib/db/rls.ts`) — borrows the connection and demotes it, for one
  transaction, to the `authenticated` role carrying that user's JWT claims. Postgres then enforces
  the RLS policies on every statement. **All user-facing reads and writes go through this.**
- **`dbAdmin`** (`src/lib/db/client.ts`) — connects as the database owner and **bypasses RLS
  entirely**. Legitimate callers: admin account operations on `profiles`, migrations, and
  `scripts/create-admin.ts`. Nothing else.

  The reminder job used to be on that list and no longer is, which is worth knowing before you add
  the next background job. It escalates **only** to enumerate active accounts
  (`profiles.listActiveRecipientsAsAdmin`, inside the same fence as every other admin read) and then
  opens `withUser({ sub })` per account for everything else. `withUser` needs only `{ sub }`, not a
  real JWT — so a job with no session can still run *inside* the policies rather than around them.
  Do that instead of reaching for `dbAdmin`; `src/lib/reminders/run.ts` is the worked example.

**No module exports a bare `db`.** That name is absent on purpose — there is no innocuous import
that hands you an unscoped connection.

**The rule in one line: no human-facing route may read data it does not own.** Adding something as
innocent as "show open task counts" to the admin UI requires `dbAdmin` and would undo the guarantee
the policies exist to give. If you want that, change the decision in `docs/gsd/devtask-pro-v1.md`
first — do not route around it in code.

`tests/integration/rls-boundary.test.ts` is the proof, not a formality. Keep it passing. Its
`task_occurrence` block is criterion 6 — an admin session reading real task data and getting zero
rows. When a phase adds a table holding user data, add a block there too; the two-user-plus-admin
harness is already built. `reminder_log` (0007) is the newest, and it also asserts at the *privilege*
level — `authenticated` holds exactly `SELECT` and `INSERT` — because that table has no `update` or
`delete` policy to consult, deliberately.

`src/lib/admin/isolation.test.ts` asserts the exact set of files importing `dbAdmin`. **A failure
there is the guard working, not a broken test.** Add the file with its reason, or — far more often —
use `withUser()` instead.

## Database

- **The SQL is authoritative.** `supabase/migrations/*.sql` are hand-written, numbered, and meant to
  be read. `src/lib/db/schema.ts` is a typed mirror you update by hand. Do **not** author DDL with
  `drizzle-kit generate` — it cannot express the `security definer` trigger or the RLS policies,
  which are the parts most worth reviewing.
- **Every new table needs explicit `GRANT`s in its own migration.** Supabase no longer auto-exposes
  new `public` entities. Without a grant, correct policies fail with *permission denied* rather than
  returning zero rows — which reads like a broken policy and is not one. Follow `0003`.
- **A new table is not created with an empty ACL — check what it starts with.** `postgres`, the role
  migrations run as, used to carry a default privilege granting `Dxtm` to `anon` and `authenticated`
  on every new `public` table. `D` is **TRUNCATE, which does not consult RLS**: any signed-in account
  could empty a table outright with no policy objecting. `0004` revokes that default, so tables
  created after it start clean — but if you ever see a client role holding a privilege no migration
  granted, that is why, and it is a security bug rather than noise.
- **All four policies, or say why not.** `profiles` has only `select`/`update` because a trigger
  creates its rows and auth cascades deletes. A user-owned table needs `insert` and `delete` too, and
  both `insert` and `update` need a `WITH CHECK` — `USING` alone lets a caller create a row owned by
  someone else, or hand their own row away by re-pointing `user_id`. See `0004`.
- **Privilege columns are guarded by a trigger, not a policy.** A `WITH CHECK` that queries the same
  table recurses. See the long comment in `0003_rls_policies.sql`. Do **not** copy that guard onto a
  table with no privileged column — `task_occurrence` deliberately has none.
- **Derived columns are maintained by triggers, not by callers.** `updated_at` (`touch_updated_at`,
  0002) and `completed_at` (`sync_task_completed_at`, 0004) are set by the database. Application code
  that writes them is fighting the trigger.
- One repo module per table under `src/lib/db/repos/`; routes and lib code call the repo, never
  Drizzle directly. `repos/occurrences.ts` is the reference: every function takes claims and opens
  its own `withUser()`, and single-row writes filter on **both** the id and `user_id` so the
  statement is correct on its own terms rather than only because a policy is in place.

## tRPC

Procedures compose in a ladder — `publicProcedure` → `protectedProcedure` → `activeProcedure` →
`adminProcedure`. **`activeProcedure` is the default for feature routers**: a `pending`, `rejected`
or `suspended` user is authenticated but must not reach application data. Validate every input with
Zod at the boundary.

## Routing and access gating

`src/proxy.ts` (Next 16 renamed `middleware` → `proxy`; it defaults to the Node.js runtime and the
`runtime` config option throws). All decision logic is the pure `routeForStatus()` in
`src/lib/access/status-route.ts` so it is testable without a request — **put new rules there, not in
the proxy**, and add the path to the always-allowed list if it must be reachable while gated, or you
will create a redirect loop. There is a fixed-point property test that catches exactly that.

The proxy reads `profiles.status` **live per request**, not from the JWT. Suspending someone does not
invalidate a token they already hold, so trusting claims would let a suspended user work until it
expires. The extra round-trip is the accepted cost; do not optimise it away.

## Conventions

- **Business logic lives in `src/lib/**`**, never inline in a component or route handler. Route
  handlers parse, delegate, serialise.
- **Validation and predicates go in a lib file, not JSX.** Anything reused, regex-based or
  multi-condition becomes a pure exported function so it can be unit-tested.
- **Types and reusable helpers live outside component files.** If you are scrolling past
  declarations to find the JSX, split them out.
- **Tests sit next to the code they test** (`foo.ts` ↔ `foo.test.ts`). Only cross-cutting suites live
  in `tests/`.
- **No sections inside cards.** A card holds one flat piece of content — no nested bordered boxes, no
  labelled sub-sections. Split into sibling cards.
- **Lists on mobile are cards, never tables.** A `<Table>` needs a stacked `md:hidden` card list;
  both presentations need their own loading and empty states.
- **Loading states are skeletons that mirror the real layout**, so resolving causes no layout shift.
  Buttons tied to an in-flight action use the `Button` `loading` prop.
- **Design tokens only.** No raw hex in `src/components/**` or `src/app/**`, no gradients, no heavy
  shadows. Hairline `line` borders do the structural work. Every token is defined in both `:root`
  and `.dark`.
- Tailwind v4 is CSS-first — there is no `tailwind.config.js` and you should not create one. Note
  that tokens declared **only** in `@theme inline` are never emitted as real CSS variables, so
  hand-written `var(--token)` outside a utility resolves to nothing. `::backdrop` is a further trap:
  it has no parent in the element tree, engines disagree about whether it inherits, and where it does
  not, `var()` silently resolves to transparent. `globals.css` uses literals there on purpose.

## Time, and the one rule about it

**Nothing under `src/components/**` may decide what day it is.** The account holder's day is resolved
on the server from `profiles.timezone` — `currentUserClock()` in `src/lib/time/current-clock.ts` is
the single call site — and handed down as a plain `YYYY-MM-DD` string. A `new Date()` in the browser
cannot agree with the server by construction, and the symptom is a flash of the wrong day just after
hydration. This is acceptance criterion 19, and it is greppable: one legitimate clock read, and
anything else computing a day or a lateness is a bug.

- `occurs_on` is a bare `date`, an intention about a calendar square. `deadline_at` is `timestamptz`,
  an instant — which is what makes `deadline_at < now()` correct in any server timezone.
- **Overdue is derived, never stored**: `deadline_at < now() and status <> 'done'`. Marking a task
  done or moving its deadline takes it out of the bucket on the next read, with no job to run.
  `overdueCondition()` in `repos/occurrences.ts` and `isOverdue()` in `lib/tasks/overdue.ts` are the
  SQL and TypeScript halves of one definition — change them together.
- **Validate zones through `canonicalTimeZone()`**, never `Intl.supportedValuesOf(...).has(value)`.
  That list does not enumerate the same spellings on every engine — this Node lists `Asia/Calcutta`
  and omits `Asia/Kolkata`, canonicalising browsers do the reverse — so two independent membership
  tests disagree across the wire and reject real users.

## End-to-end tests

Three rules, each of which has already cost a debugging session.

- **Never write a bare `fill()` in a spec — go through `fillForm()`** (`e2e/helpers/forms.ts`). A
  controlled input filled between HTML arriving and React hydrating takes the raw DOM value and
  dispatches an event nobody is listening to yet; component state stays empty and the first
  controlled render wipes the field. The symptom is not "the field is empty" but a timeout waiting
  for a navigation, with the form's own validation error in the snapshot. `fillForm` fills every
  field and then `toPass`-asserts the values survived, so it re-fills once hydration lands. It is
  deterministic on the `mobile` project (WebKit) and a coin-flip on `chromium`, which is why a spec
  that passes locally is not evidence.
- **Select by role, never by CSS or test id.** Every list renders **both** presentations at once — a
  `<Table>` inside `hidden md:block` and a card stack inside `md:hidden` — so each task's controls
  exist twice in the DOM with exactly one copy displayed. Playwright's role engine ignores what the
  accessibility tree ignores, so `getByRole` resolves to whichever presentation is visible and one
  line covers both projects. A CSS selector matches both copies and fails strict mode on one of them.
- **That only works because rows and cards name their controls identically** — `Edit <title>`,
  `Status of <title>`, `Progress of <title>`. `task-row.tsx` and `task-card.tsx` must stay in step;
  renaming in one is a silent e2e break in the other.

Seeding through the service role (`e2e/helpers/tasks.ts`) is for arrangements the UI is deliberately
awkward at — a deadline a known number of minutes in the *past* — not a shortcut around the app. The
behaviour is still asserted through the browser, and that a user cannot write somebody else's row is
proven in `tests/integration/rls-boundary.test.ts`, not here.

**Timeouts belong in `playwright.config.ts`, not in a spec.** The suite runs `fullyParallel` against
one `next dev`, which compiles each route the first time anybody asks for it, so a spec that passes
alone can time out in the full run on a route it does not even touch. The budgets there are sized for
that; before treating a timeout as a regression, run the spec on its own and see whether it passes.

## Commands and gates

```bash
pnpm dev                 # app on :3000
pnpm db:start            # local Supabase (Docker); Studio :54423, Mailpit :54424, SMTP :54425
pnpm db:reset            # re-apply migrations
pnpm admin:create        # idempotent bootstrap admin from ADMIN_EMAIL/ADMIN_PASSWORD
```

**A `supabase/config.toml` change needs `supabase stop` then `pnpm db:start` — `db:reset` will not
pick it up.** That is how the reminder job's SMTP port (54425) is exposed; without a restart
`nodemailer` fails with `ECONNREFUSED`, which reads as a code bug and is not one.

**Gates — all four must pass before any PR:**

```bash
pnpm typecheck && pnpm lint && pnpm build && pnpm test
```

`pnpm test` is unit only. **`pnpm test:integration` needs the live stack** and is excluded from the
default run so CI stays green without a database — but it is where the access model is actually
proven, so run it when you touch data access. `pnpm test:e2e` drives Playwright.

Evidence before assertions: run the gates and read the output rather than assuming.

## Branch model

`feature → main`. A session **never merges** — the PR is for a human.

## Pinned versions, and why

- **ESLint stays on 9.x.** ESLint 10 breaks `eslint-plugin-react`
  (`contextOrFilename.getFilename is not a function`), which `eslint-config-next` depends on.
- **pnpm build permissions live in `pnpm-workspace.yaml`** (`allowBuilds`), not
  `pnpm.onlyBuiltDependencies` in `package.json` — pnpm 11 ignores the latter, and without it esbuild
  never builds and vitest cannot run.
