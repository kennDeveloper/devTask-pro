/**
 * Where a confirmed / recovered session lands once Supabase hands it back.
 *
 * The middleware re-routes from here by account status (pending → /pending,
 * suspended → /no-access), so every auth path can aim at the same door.
 */
export const DEFAULT_POST_AUTH_PATH = "/today";

/**
 * Absolute URL for the PKCE callback. Prefers the build-time
 * NEXT_PUBLIC_SITE_URL (deterministic per environment) and falls back to the
 * current browser origin. This prevents confirmation and password-reset
 * emails from pointing at localhost when the deployed Supabase project's
 * Site URL is misconfigured.
 *
 * `next` is the in-app path to continue to after the code exchange. Omit it
 * to use the callback's own default.
 */
export function authCallbackUrl(next?: string): string {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
    (typeof window !== "undefined" ? window.location.origin : "");
  const callback = `${base}/auth/callback`;
  return next
    ? `${callback}?next=${encodeURIComponent(safeNextPath(next))}`
    : callback;
}

/**
 * Constrain a caller-supplied `?next=` to a same-origin in-app path.
 *
 * `startsWith("/")` alone is not enough: `//evil.example` also starts with a
 * slash, and `new URL("//evil.example", origin)` resolves to a *different
 * origin* — an open redirect. `/\evil.example` is the same trick with the
 * slash browsers normalise. Both are rejected here.
 */
export function safeNextPath(
  value: string | null | undefined,
  fallback: string = DEFAULT_POST_AUTH_PATH,
): string {
  if (!value || !value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  return value;
}
