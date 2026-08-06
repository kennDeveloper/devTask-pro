import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { DEFAULT_POST_AUTH_PATH, safeNextPath } from "@/lib/auth/redirect";

/**
 * PKCE callback.
 *
 * Supabase redirects here with a `?code=` query param after the user follows
 * an email confirmation or password-recovery link. We exchange that code for
 * a session (which sets the auth cookies via the server client) and then
 * redirect into the app.
 *
 * `?next=` may override the post-auth destination — password recovery points
 * it at `/reset-password`. It is run through `safeNextPath` so it can only
 * ever be a same-origin in-app path.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = safeNextPath(
    url.searchParams.get("next"),
    DEFAULT_POST_AUTH_PATH,
  );

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL(next, url.origin));
    }
  }

  // No code, or the exchange failed (link already used, or expired) — bounce
  // back to sign-in with an error flag the page turns into a sentence.
  return NextResponse.redirect(new URL("/sign-in?error=auth", url.origin));
}
