"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import { useState } from "react";

import type { AppRouter } from "./routers/_app";

/**
 * The typed browser client. Hooks are inferred from `AppRouter`, so a rename on
 * the server is a compile error here rather than a 404 at runtime.
 */
export const trpc = createTRPCReact<AppRouter>();

function getBaseUrl() {
  if (typeof window !== "undefined") return "";
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Long enough that navigating back to a screen does not refetch, short
        // enough that a status change lands without a hard reload.
        staleTime: 30_000,
        // UNAUTHORIZED and FORBIDDEN are verdicts, not transient failures.
        // Retrying them just delays the redirect the caller needs.
        retry(failureCount, error) {
          const code = (error as { data?: { code?: string } }).data?.code;
          if (code === "UNAUTHORIZED" || code === "FORBIDDEN") return false;
          return failureCount < 2;
        },
      },
    },
  });
}

export function TRPCProvider({ children }: { children: React.ReactNode }) {
  // Both held in `useState` initialisers so they are created once per browser
  // mount. Creating them at module scope would share one cache across every
  // user rendered by a single server process.
  const [queryClient] = useState(createQueryClient);
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [httpBatchLink({ url: `${getBaseUrl()}/api/trpc` })],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
