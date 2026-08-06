import type { SupabaseClient, User } from "@supabase/supabase-js";
import { initTRPC, TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";

import { withUser } from "@/lib/db/rls";
import { profiles, type Profile } from "@/lib/db/schema";

export type { Profile };

/**
 * tRPC context — built once per request by the fetch adapter in
 * `src/app/api/trpc/[trpc]/route.ts`.
 *
 * - `supabase` — the request-scoped Supabase server client (cookie-backed).
 * - `user`     — the Supabase Auth user, validated against Supabase, or `null`.
 * - `profile`  — the caller's own `public.profiles` row, or `null`.
 *
 * There is deliberately no `organisationId`. devtask-pro is per-user private,
 * not multi-tenant: every row is owned by exactly one person and RLS scopes on
 * `auth.uid()`. Adding a tenant id here would invent a second, weaker access
 * axis alongside the one the database already enforces.
 */
export interface Context {
  supabase: SupabaseClient | null;
  user: User | null;
  profile: Profile | null;
}

/**
 * Builds the tRPC context from a Supabase server client.
 *
 * Two things here are load-bearing:
 *
 * 1. **`getUser()`, never `getSession()`.** `getSession()` reads the cookie and
 *    decodes it locally — it does not verify the signature with Supabase, so a
 *    forged or tampered token would be handed straight to the procedures below.
 *    `getUser()` round-trips to the auth server and returns `null` unless the
 *    token genuinely validates. Every rung of the procedure ladder trusts
 *    `ctx.user`, so it has to be a fact, not a claim.
 *
 * 2. **The profile is read through `withUser()`, not `dbAdmin`.** This is the
 *    house rule (see `src/lib/db/client.ts`): user-facing reads go through the
 *    RLS-scoped path. Practically, `profiles_select_own` in
 *    `supabase/migrations/0003_rls_policies.sql` means the query below cannot
 *    return anybody else's row even if the `where` clause were wrong — the
 *    database, not this file, is what guarantees the caller sees only their own
 *    profile. `dbAdmin` is reserved for the reminder job, admin account
 *    operations, and migrations.
 */
export async function buildContext(
  supabase: SupabaseClient | null,
): Promise<Context> {
  if (!supabase) {
    return { supabase: null, user: null, profile: null };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { supabase, user: null, profile: null };
  }

  let profile: Profile | null = null;
  try {
    profile = await withUser({ sub: user.id, email: user.email }, async (tx) => {
      const rows = await tx
        .select()
        .from(profiles)
        .where(eq(profiles.id, user.id))
        .limit(1);
      return rows[0] ?? null;
    });
  } catch (error) {
    // The database is unreachable or not yet provisioned. Fail *closed*: a null
    // profile leaves the caller authenticated but not active, so `activeProcedure`
    // and `adminProcedure` reject them rather than a partial context leaking
    // through as if they had been approved.
    console.error("[trpc] failed to load profile for", user.id, error);
    profile = null;
  }

  return { supabase, user, profile };
}

const t = initTRPC.context<Context>().create();

/** Router / caller helpers. */
export const createTRPCRouter = t.router;
export const router = t.router;
export const createCallerFactory = t.createCallerFactory;
export const mergeRouters = t.mergeRouters;

/**
 * A context that has passed `protectedProcedure` — `user` is guaranteed.
 */
export type AuthedContext = Context & { user: User };

/**
 * A context that has passed `activeProcedure` — `user` and `profile` are both
 * guaranteed, and `profile.status === "active"`.
 */
export type ActiveContext = AuthedContext & { profile: Profile };

// ---------------------------------------------------------------------------
// THE PROCEDURE LADDER
// ---------------------------------------------------------------------------
//
// Each rung is strictly narrower than the one above it, and each is composed
// from its predecessor so the checks run in order and the error codes come out
// in the right precedence: an anonymous caller hitting `adminProcedure` gets
// UNAUTHORIZED (you are nobody), not FORBIDDEN (you are somebody, but not this).
//
//   publicProcedure     anyone, including signed-out visitors
//   protectedProcedure  + a validated Supabase Auth user
//   activeProcedure     + an approved account  (status === "active")
//   adminProcedure      + the admin role
//
// Narrowing matters as much as rejecting: each middleware hands the next one a
// context with the field it checked proven non-null, so resolvers downstream
// read `ctx.user.id` / `ctx.profile.timezone` without re-testing. A resolver
// that has to write `ctx.user!` is a sign it is sitting on the wrong rung.

/**
 * Open to everyone, signed in or not.
 *
 * Protects against nothing — that is the point. Anything mounted here is
 * public API surface, so it must not read user data. In phase 1 nothing uses
 * it; it exists so "no auth needed" is an explicit choice at the call site
 * rather than the absence of one.
 */
export const publicProcedure = t.procedure;

/**
 * Requires a validated Supabase Auth user.
 *
 * Protects against: unauthenticated access. Rejects with UNAUTHORIZED, which
 * the client reads as "sign in", not "you are not allowed".
 *
 * Note this is a *weak* rung on purpose. It says the caller proved who they
 * are, and nothing about whether they have been approved to use the app — a
 * `pending`, `rejected` or `suspended` account passes here. Only procedures a
 * gated user legitimately needs (reading their own profile to render
 * `/pending`) should stop at this rung.
 */
const isAuthed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({ ctx: { user: ctx.user } });
});

export const protectedProcedure = t.procedure.use(isAuthed);

/**
 * Requires an approved account: `profile.status === "active"`.
 *
 * Protects against: an authenticated-but-ungated user reaching application
 * data. Signing up and confirming an email makes you a *user*; an admin
 * approving you makes you a *member*. Between those two moments a person holds
 * a perfectly valid JWT, so `protectedProcedure` alone would let them read and
 * write tasks. Likewise a suspended account still holds its unexpired token —
 * revoking access has to bite on the row, not the token.
 *
 * A missing profile is treated the same as a non-active one. That is the
 * fail-closed branch for "the profile row could not be loaded" (see
 * `buildContext`) and for the brief window after `auth.users` insert before the
 * `handle_new_user` trigger's row is visible.
 *
 * **This is the default rung for feature routers.** Phase 2 onwards should
 * build on `activeProcedure` unless there is a written reason not to.
 */
const isActive = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (!ctx.profile || ctx.profile.status !== "active") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Your account is not active",
    });
  }
  return next({ ctx: { user: ctx.user, profile: ctx.profile } });
});

export const activeProcedure = protectedProcedure.use(isActive);

/**
 * Requires `profile.role === "admin"` **and** an active account.
 *
 * Protects against: a member reaching the account-administration surface
 * (approve / reject / suspend / trigger a password reset, phase 5).
 *
 * Because it is composed on top of `activeProcedure`, a suspended admin is
 * rejected before the role is even looked at — losing your account access has
 * to cost you your admin access too, or suspension is not a revocation.
 *
 * What this rung is *not*: a data-visibility grant. `admin` governs which
 * operations exist, never which rows are readable. RLS scopes on `auth.uid()`
 * and knows nothing about roles, so an admin session reading a task table sees
 * their own rows and nobody else's. Admin operations that legitimately need to
 * cross that boundary go through `dbAdmin` and are restricted to `profiles`.
 */
const isAdmin = t.middleware(({ ctx, next }) => {
  if (ctx.profile?.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin role required",
    });
  }
  return next();
});

export const adminProcedure = activeProcedure.use(isAdmin);
