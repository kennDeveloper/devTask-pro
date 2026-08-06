import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { authCallbackUrl } from "@/lib/auth/redirect";

/**
 * THE SERVICE-ROLE AUTH CLIENT. Read this before using it.
 *
 * This module holds the service-role key, which is the auth service's equivalent
 * of `dbAdmin`: it can act on any account. It exists for exactly three
 * operations, all of them about *access* rather than data:
 *
 *   - ban an account, so a live session cannot be refreshed;
 *   - lift that ban;
 *   - ask GoTrue to email somebody a password-recovery link.
 *
 * It deliberately exports **operations, not the client**. Handing callers a
 * service-role `SupabaseClient` would hand them `.from("task_occurrence")` as
 * well, which reaches the Data API as `service_role` and bypasses every RLS
 * policy — the exact hole `src/lib/db/client.ts` is careful about on the
 * Postgres side. Database work belongs to `src/lib/db/repos/profiles.ts`, which
 * is fenced off and labelled for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BAN ACTUALLY DOES — measured against the local stack, not assumed
 * ---------------------------------------------------------------------------
 * This matters because the answer decides where a just-suspended user lands, and
 * guessing it wrong changes the meaning of brief criterion 3 without anybody
 * noticing.
 *
 *   GET /auth/v1/user with the already-issued access token  ->  200, still
 *   POST /auth/v1/token?grant_type=refresh_token            ->  400 user_banned
 *
 * So the ban does **not** invalidate a token already in a browser. The proxy's
 * live `profiles.status` read is what lands a suspended user on /no-access on
 * their very next navigation, and `activeProcedure` does the same for API calls.
 * What the ban adds is that the session cannot outlive its current access token,
 * and that nothing can mint a new one. The two mechanisms cover different halves
 * and neither is redundant — dropping the ban would leave a suspended account
 * able to refresh indefinitely.
 *
 * ---------------------------------------------------------------------------
 * WHY RECOVERY GOES THROUGH `resetPasswordForEmail`, NOT `generateLink`
 * ---------------------------------------------------------------------------
 * `admin.generateLink` returns a credential-bearing recovery URL **to the
 * caller**. An admin who can mint a link that signs them in as any member is an
 * admin who can read that member's tasks — through an ordinary member session,
 * which RLS would serve happily because it *is* that member's session. No policy
 * can close that; it is an account takeover with a button.
 *
 * `resetPasswordForEmail` sends the link to the account holder's own inbox and
 * returns nothing useful to the admin. Same endpoint the /forgot-password page
 * already uses, same rate limiting, same one-hour expiry.
 */

/**
 * Effectively forever. GoTrue takes a Go duration string and has no "permanent"
 * value, so a ban is expressed as a hundred years. Reinstating passes `"none"`,
 * which is the documented and measured way to lift one — not a zero duration,
 * which GoTrue rejects.
 */
export const BAN_DURATION = "876000h";
export const UNBAN_DURATION = "none";

/**
 * Where a recovery link lands: the PKCE callback, which exchanges the code for a
 * session and then forwards to /reset-password with that session in place.
 * Without the `next` hop the user arrives signed in at their home screen with no
 * way to set a password. Identical to what the /forgot-password page requests,
 * so both routes are one flow with one destination.
 */
export const RECOVERY_REDIRECT_PATH = "/reset-password";

let cached: SupabaseClient | null = null;

/**
 * Lazily built, so `next build` — which imports the route graph for static
 * analysis — does not need the service-role key to be present. Same reasoning as
 * the Proxy around `dbAdmin`.
 *
 * Not exported. See the note above about handing out `.from()`.
 */
function adminAuthClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL are required for admin account operations",
    );
  }

  cached = createClient(url, key, {
    // A server-side client that acts on many accounts must never persist or
    // refresh a session of its own — there is no session, only the key.
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}

/**
 * Ban or unban an account in Supabase Auth.
 *
 * Throws on failure rather than returning a flag: the caller has already moved
 * the status column, and an auth call that silently did nothing would leave a
 * suspended account whose session still refreshes. That is a state the admin
 * must be told about, not one to swallow.
 */
export async function setAccountBanned(
  userId: string,
  banned: boolean,
): Promise<void> {
  const { error } = await adminAuthClient().auth.admin.updateUserById(userId, {
    ban_duration: banned ? BAN_DURATION : UNBAN_DURATION,
  });

  if (error) {
    throw new Error(
      `Could not ${banned ? "ban" : "unban"} the account: ${error.message}`,
    );
  }
}

/**
 * Send a password-recovery email to an address.
 *
 * The admin is told it was sent and is never shown the link. Rate-limit errors
 * are surfaced because they are a property of the sender and swallowing one
 * would leave everybody waiting for mail that was never dispatched — the same
 * distinction `/forgot-password` draws. Account enumeration is not a concern
 * here: the admin is looking at the account list.
 */
export async function sendRecoveryEmail(email: string): Promise<void> {
  const { error } = await adminAuthClient().auth.resetPasswordForEmail(email, {
    redirectTo: authCallbackUrl(RECOVERY_REDIRECT_PATH),
  });

  if (error) {
    throw new Error(`Could not send the reset email: ${error.message}`);
  }
}

/** Test seam. Drops the memoised client so a spec can swap the environment. */
export function resetAdminAuthClientForTests(): void {
  cached = null;
}
