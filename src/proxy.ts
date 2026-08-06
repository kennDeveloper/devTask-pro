import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import {
  parseAccountStatus,
  routeForStatus,
  type AccountStatus,
} from "@/lib/access/status-route";

/**
 * Refreshes the Supabase session cookie on every request so Server
 * Components always see a fresh session, then routes the request according to
 * the caller's account status.
 *
 * Reads as: refresh session -> fetch status -> ask `routeForStatus` -> redirect
 * or continue. All of the decision logic lives in
 * `src/lib/access/status-route.ts`, which is pure and exhaustively tested;
 * this file only does the I/O.
 */
export async function proxy(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: do not run code between createServerClient and getUser().
  // Touching getUser() refreshes the session if it is about to expire.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // --- Everything below is devtask-pro's access gate. ------------------------

  let status: AccountStatus | null = null;

  if (user) {
    // Read the status from the row, NOT from the JWT.
    //
    // Suspending someone does not invalidate an access token they already
    // hold. A proxy that trusted the token's claims would keep letting a
    // suspended user work until it expired — up to an hour. Reading
    // `profiles.status` per request is what makes "suspension terminates a
    // live session" (brief criterion 4) actually true.
    //
    // This costs one database round-trip per navigation. That cost is accepted
    // and recorded in the plan's risk table; do not optimise it away by
    // trusting the token, and do not reach for `dbAdmin` here. The query goes
    // through the request-scoped client above, so RLS applies: the
    // `profiles_select_own` policy means the caller can only ever see their own
    // row, and a bug in this file cannot turn into a data leak.
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("status")
        .eq("id", user.id)
        .maybeSingle();

      if (error) {
        console.error(
          "[proxy] could not read profiles.status:",
          error.message,
        );
      }

      status = parseAccountStatus(data?.status);
    } catch (cause) {
      // A throw here would 500 every page in the app. The 0002 trigger means a
      // signed-in user should always have a row, so treat a failed read as
      // "not provisioned" — routeForStatus sends that to /sign-in.
      console.error("[proxy] profiles.status read failed:", cause);
      status = null;
    }
  }

  const destination = routeForStatus({
    status,
    isSignedIn: Boolean(user),
    pathname: request.nextUrl.pathname,
  });

  if (destination === null) {
    return supabaseResponse;
  }

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = destination;
  redirectUrl.search = "";

  const redirectResponse = NextResponse.redirect(redirectUrl);

  // Carry over any cookies `getUser()` just refreshed. Without this the
  // rotated tokens are dropped on the floor and the next request re-refreshes
  // from a stale refresh token, which eventually signs the user out.
  supabaseResponse.cookies
    .getAll()
    .forEach((cookie) => redirectResponse.cookies.set(cookie));

  return redirectResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - image asset extensions
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
