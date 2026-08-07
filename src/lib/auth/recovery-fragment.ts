/**
 * Reading an implicit-grant recovery session out of a URL fragment.
 *
 * ============================================================================
 * WHY THIS EXISTS — the two recovery links are not the same shape
 * ============================================================================
 *
 * devtask-pro can send a password-recovery link from two places, and they are
 * different flows whether we like it or not:
 *
 *   /forgot-password        the user asks, from their own browser.
 *                           `@supabase/ssr` is in PKCE mode, so it mints a
 *                           verifier, stores it in a cookie, and GoTrue emails a
 *                           link carrying `?code=`. `/auth/callback` reads the
 *                           cookie and exchanges the code. This is the path that
 *                           has always worked.
 *
 *   admin "send reset"      the server asks, on somebody else's behalf (phase 5).
 *                           PKCE is impossible by construction: the verifier
 *                           would have to travel from this server to the account
 *                           holder's browser, which is exactly what PKCE exists
 *                           to prevent. GoTrue therefore issues an **implicit**
 *                           link, carrying the whole session in the URL
 *                           *fragment*:
 *
 *                               /reset-password#access_token=…&type=recovery
 *
 * A fragment is never sent to a server, so no route handler can help. And the
 * browser client cannot pick it up on its own either: `createBrowserClient`
 * hard-sets `flowType: "pkce"`, and supabase-js explicitly refuses an implicit
 * URL in that mode — `_getSessionFromURL` throws *"Not a valid PKCE flow url."*
 * and the page settles on "this link is no longer valid" while holding a
 * perfectly good session in the address bar. That was measured, not guessed.
 *
 * So `/reset-password` adopts the fragment itself, with `setSession()`, which
 * does not care which flow produced the tokens. This module is the parsing half,
 * kept pure and out of the component per `AGENTS.md` — anything regex-based or
 * multi-condition becomes a testable exported function.
 */

/** The two tokens `supabase.auth.setSession()` needs. */
export interface RecoveryGrant {
  accessToken: string;
  refreshToken: string;
}

/**
 * The tokens in a recovery fragment, or `null` if this is not one.
 *
 * Deliberately strict on three points:
 *
 * 1. **`type` must be `recovery`.** GoTrue uses the same fragment shape for
 *    magic links, invites and email-change confirmations. This page's whole
 *    purpose is setting a password, and adopting a session that arrived for some
 *    other reason would be a different feature happening by accident.
 * 2. **Both tokens must be present.** An access token alone produces a session
 *    that cannot refresh and dies in an hour, mid-form.
 * 3. **An `error` in the fragment returns `null`.** GoTrue reports an expired or
 *    spent link that way, and it must land on the page's honest "no longer
 *    valid" screen rather than on a form that cannot submit.
 */
export function parseRecoveryFragment(hash: string): RecoveryGrant | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }

  if (params.get("error") || params.get("error_code")) return null;
  if (params.get("type") !== "recovery") return null;

  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return null;

  return { accessToken, refreshToken };
}

/**
 * True when a fragment carries a recovery grant. Sugar over the parser so a
 * caller that only needs the question does not have to discard the answer.
 */
export function hasRecoveryFragment(hash: string): boolean {
  return parseRecoveryFragment(hash) !== null;
}
