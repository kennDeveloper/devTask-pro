import { TRPCError } from "@trpc/server";
import { z } from "zod";

import * as profilesRepo from "@/lib/db/repos/profiles";
import type { Profile } from "@/lib/db/schema";
import { canonicalTimeZone } from "@/lib/profile-form";

import { activeProcedure, protectedProcedure, router } from "../server";

/**
 * The IANA zones this runtime actually knows about.
 *
 * Computed once at module load. `Intl.supportedValuesOf("timeZone")` is the
 * runtime's own tz database, which is exactly the right authority: a zone this
 * check accepts is a zone `Intl.DateTimeFormat` can later format with. A
 * free-text timezone column is a live bug for the reminder job in phase 6 —
 * "Australia/Sydney" typed as "Australia/Sidney" would silently send every
 * reminder at the wrong hour, or throw inside a cron run nobody is watching.
 *
 * **`"UTC"` is added by hand, and has to be.** `supportedValuesOf` returns only
 * *canonical* zone identifiers and drops every link/alias, which means it omits
 * "UTC", "Etc/UTC" and "GMT" — verified on Node 22: 418 zones, none of them
 * "UTC". Since `profiles.timezone` defaults to `'UTC'` (0001), a strict set
 * membership test would reject the value the database itself just wrote, and
 * every account would fail to save its settings form until it picked a
 * different zone. The alias set stays deliberately at exactly one entry:
 * validating via `Intl.DateTimeFormat(...)` instead would widen this to accept
 * raw offsets like "+10:00" and legacy names like "US/Eastern", neither of
 * which is an IANA zone we want persisted.
 */
// Validation lives in `src/lib/profile-form.ts` so the browser and this resolver
// apply exactly one rule. They used not to: both did their own
// `supportedValuesOf(...).has(value)`, which looks like agreement and is not —
// the two runtimes enumerate different spellings of the same zones, so a browser
// reporting "Asia/Kolkata" passed the client check and failed here. See the long
// note on `canonicalTimeZone`.

/**
 * Input for `profile.update`.
 *
 * Note what is absent: `role` and `status`. Leaving them out of the schema is
 * the *polite* half of the guard. The real one is
 * `guard_profile_privileged_columns()` in
 * `supabase/migrations/0003_rls_policies.sql`, a BEFORE UPDATE trigger that
 * raises if the account holder tries to move either column — which holds even
 * if a future resolver forgets, or passes an unvalidated object straight to
 * `.set()`. Zod here is a better error message; the database is the boundary.
 */
export const profileUpdateInput = z
  .object({
    displayName: z.string().trim().min(1).max(80).optional(),
    /**
     * Transformed, not merely checked. Whatever spelling the client sends, the
     * column receives the canonical one — so `profiles.timezone` only ever holds
     * a name this runtime enumerates, and the phase 6 reminder job never has to
     * wonder whether a stored value is an alias.
     */
    timezone: z
      .string()
      .transform((value) => canonicalTimeZone(value))
      .refine((value): value is string => value !== null, {
        message: "Not a recognised IANA time zone",
      })
      .optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one field to update",
  });

/**
 * A JSON-safe view of a profile row.
 *
 * The tRPC link has no transformer configured, so `Date` columns cross the wire
 * as ISO strings. Serialising them here keeps the client's inferred type honest
 * instead of promising a `Date` the client will never receive. `approvedBy` is
 * dropped: it names another account and the owner has no use for it.
 */
function toPublicProfile(profile: Profile) {
  return {
    id: profile.id,
    email: profile.email,
    displayName: profile.displayName,
    timezone: profile.timezone,
    role: profile.role,
    status: profile.status,
    approvedAt: profile.approvedAt?.toISOString() ?? null,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}

export type PublicProfile = ReturnType<typeof toPublicProfile>;

export const profileRouter = router({
  /**
   * The caller's own profile.
   *
   * Deliberately `protectedProcedure` and not `activeProcedure`: `/pending` and
   * `/no-access` have to render for exactly the accounts `activeProcedure`
   * rejects, and they render by reading `status` from here. Gating this on
   * `active` would leave a pending user staring at a screen that cannot explain
   * why they are on it.
   *
   * `ctx.profile` was already loaded through `withUser()` in `buildContext`, so
   * this is a projection of a row the database has already confirmed belongs to
   * the caller — not a second, unscoped lookup.
   */
  get: protectedProcedure.query(({ ctx }) =>
    ctx.profile ? toPublicProfile(ctx.profile) : null,
  ),

  /**
   * Update the caller's own display name and/or timezone.
   *
   * `activeProcedure`: editing your profile is an application action, and a
   * pending or suspended account should not be doing application actions.
   *
   * The write goes through `withUser()`, so `profiles_update_own` applies. The
   * `where` clause below is belt-and-braces — RLS would reduce the update to
   * the caller's own row regardless — but an unbounded `update` with no `where`
   * is a bad habit to leave in the codebase for the next table, which may be
   * added before its policies are.
   *
   * `updated_at` is not set here: the `profiles_touch_updated_at` trigger in
   * 0002 maintains it.
   */
  update: activeProcedure
    .input(profileUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const updated = await profilesRepo.updateOwn(
        { sub: ctx.user.id, email: ctx.user.email },
        { displayName: input.displayName, timezone: input.timezone },
      );

      if (!updated) {
        // RLS returned no row. Either the profile vanished mid-request or the
        // caller's claims did not match it — both are "not yours", not "broken".
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Profile not found",
        });
      }

      return toPublicProfile(updated);
    }),
});
