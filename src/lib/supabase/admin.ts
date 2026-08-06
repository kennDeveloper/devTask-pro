import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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
 * Where a recovery link lands.
 *
 * ============================================================================
 * STRAIGHT TO /reset-password — NOT THROUGH /auth/callback. THIS IS FORCED.
 * ============================================================================
 *
 * `/forgot-password` aims its link at `/auth/callback`, because that page calls
 * `resetPasswordForEmail` **from the browser**, where supabase-js is in PKCE
 * mode: it mints a code challenge, stores the verifier in that browser's
 * storage, and GoTrue emails a link carrying `?code=`. The callback route
 * exchanges the code for a session.
 *
 * An admin-triggered reset cannot work that way, and no configuration makes it.
 * PKCE requires the client that *initiated* the flow to be the client that
 * *redeems* it — the verifier never leaves that browser. Here the initiator is
 * this server and the redeemer is the account holder's browser, which has no
 * verifier and never will. So GoTrue issues an **implicit-flow** link instead,
 * carrying the session in the URL *fragment*:
 *
 *     /auth/callback#access_token=…&type=recovery
 *
 * A fragment is never sent to the server. The callback route handler therefore
 * sees no `?code=`, concludes the link is spent, and bounces the user to
 * `/sign-in?error=auth` — with a perfectly good session sitting in a fragment
 * nobody read. That is exactly what happened the first time this was written.
 *
 * Pointing at `/reset-password` directly fixes it, because that page is a client
 * component holding a `createBrowserClient`, whose `detectSessionInUrl` default
 * parses the fragment and establishes the session before the page asks
 * `getSession()`. `/reset-password` is in `ALWAYS_ALLOWED_PREFIXES`, so the
 * proxy lets the request through while the caller still looks signed out.
 */
export const RECOVERY_REDIRECT_PATH = "/reset-password";

/**
 * The absolute URL for that path.
 *
 * Built here rather than through `authCallbackUrl()` because this flow
 * deliberately does not go through the callback. `NEXT_PUBLIC_SITE_URL` is the
 * same variable that helper prefers, so both land on the same origin — and it is
 * required rather than optional here: there is no `window.location` to fall back
 * to on a server, and a relative `redirectTo` would be rejected by GoTrue.
 */
function recoveryRedirectUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is required to send a password-reset email",
    );
  }
  return `${base}${RECOVERY_REDIRECT_PATH}`;
}

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
    redirectTo: recoveryRedirectUrl(),
  });

  if (error) {
    throw new Error(`Could not send the reset email: ${error.message}`);
  }
}

/** Test seam. Drops the memoised client so a spec can swap the environment. */
export function resetAdminAuthClientForTests(): void {
  cached = null;
}
