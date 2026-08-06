import { eq } from "drizzle-orm";

import { withUser, type UserClaims } from "@/lib/db/rls";
import { profiles, type Profile } from "@/lib/db/schema";

/**
 * The `profiles` repo.
 *
 * `AGENTS.md` has always said one repo module per table, with routes and lib code
 * calling the repo rather than Drizzle. Phase 1 shipped without the directory, so
 * `buildContext` and `profile.update` each grew their own query. Phase 2 created
 * `repos/occurrences.ts` for the first real data table, and leaving `profiles` as
 * the one exception would have made the convention a thing you have to already
 * know rather than a thing the code shows you.
 *
 * Both functions here go through `withUser()`, so `profiles_select_own` and
 * `profiles_update_own` (0003) apply. There is no `dbAdmin` path in this module:
 * admin account operations belong to the phase 5 admin tier and will need their
 * own clearly-named entry points, precisely so that "read my profile" and "change
 * somebody else's status" never share a function.
 */

/**
 * The caller's own profile row, or `null`.
 *
 * `null` is not an error. It happens when the row genuinely does not exist yet —
 * the `handle_new_user` trigger runs on `auth.users` insert, so there is a narrow
 * window during signup — and callers are expected to treat it as "not active",
 * failing closed. See `buildContext`.
 *
 * The `where` is belt-and-braces: `profiles_select_own` already reduces this to
 * the caller's row, so the clause cannot change the result. It is written anyway
 * so the statement is correct on its own terms rather than correct only because a
 * policy happens to be in place.
 */
export async function findOwn(claims: UserClaims): Promise<Profile | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .select()
      .from(profiles)
      .where(eq(profiles.id, claims.sub))
      .limit(1);

    return rows[0] ?? null;
  });
}

/**
 * Fields the account holder may change about themselves.
 *
 * Note what is absent, and that it is absent in three places at once: `role` and
 * `status` are missing from this type, from `profileUpdateInput`'s Zod schema, and
 * — the one that actually stops it — from what
 * `guard_profile_privileged_columns()` in 0003 will allow. The type and the schema
 * are courtesy; the trigger is the boundary, and it holds even if a future
 * resolver passes an unvalidated object straight to `.set()`.
 */
export interface UpdateOwnProfilePatch {
  displayName?: string;
  timezone?: string;
}

/**
 * Update the caller's own profile. Returns the updated row, or `null` if RLS
 * matched nothing.
 *
 * `undefined` fields are omitted rather than written, so a patch naming only a
 * timezone cannot blank a display name. `updated_at` is left alone — the
 * `profiles_touch_updated_at` trigger in 0002 maintains it.
 */
export async function updateOwn(
  claims: UserClaims,
  patch: UpdateOwnProfilePatch,
): Promise<Profile | null> {
  return withUser(claims, async (tx) => {
    const rows = await tx
      .update(profiles)
      .set({
        ...(patch.displayName !== undefined && {
          displayName: patch.displayName,
        }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
      })
      .where(eq(profiles.id, claims.sub))
      .returning();

    return rows[0] ?? null;
  });
}
