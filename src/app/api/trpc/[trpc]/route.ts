import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createClient } from "@/lib/supabase/server";
import { appRouter } from "@/lib/trpc/routers/_app";
import { buildContext } from "@/lib/trpc/server";

/**
 * The single HTTP entry point for the whole API.
 *
 * The context is rebuilt from scratch on every request — there is no cached
 * user and no cached profile. That is what makes suspension bite immediately:
 * an admin flipping `status` to `suspended` takes effect on the caller's very
 * next request, even though their JWT is still perfectly valid and will remain
 * so until it expires. Caching the profile here would reintroduce exactly the
 * delay the middleware in task 7 goes out of its way to avoid.
 */
function handler(req: Request) {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: async () => buildContext(await createClient()),
    onError({ path, error }) {
      // Expected access-control rejections are the ladder working, not faults.
      if (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN") return;
      console.error(`[trpc] ${path ?? "<no-path>"}:`, error);
    },
  });
}

export { handler as GET, handler as POST };
