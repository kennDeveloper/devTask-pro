/**
 * The types every component in this directory shares.
 *
 * They live here rather than in a component file for the reason AGENTS.md
 * gives: if you have to scroll past declarations to reach the JSX, the
 * declarations are in the wrong file.
 */

import type { inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@/lib/trpc/routers/_app";

/**
 * One account, exactly as the browser receives it.
 *
 * Inferred from the router rather than imported as `PublicAccount` from
 * `routers/admin.ts`, for the same reason `components/tasks/types.ts` does it:
 * `routers/admin.ts` reaches `dbAdmin` and the `postgres` driver, and only a
 * *type* import keeps that out of the client bundle. Reading it off `AppRouter`
 * — already a type-only import — removes the possibility of somebody later
 * turning it into a value import by accident.
 *
 * Note what this type does **not** have and cannot acquire: any task field. The
 * admin tier sees account metadata only, and the shape it receives is the
 * evidence rather than the promise.
 *
 * `createdAt`, `approvedAt` and `lastSignInAt` are **strings**. The tRPC link
 * has no transformer, so a `Date` never survives the wire.
 */
export type Account = inferRouterOutputs<AppRouter>["admin"]["list"][number];

/**
 * The identity of the signed-in admin, resolved on the server and handed down.
 *
 * The list needs it for one reason: to mark the admin's own row and withhold its
 * action buttons. That is presentation — the actual guarantee is in
 * `routers/admin.ts`, which refuses a self-targeted action whatever the client
 * sends. Passing the id down rather than re-reading a session in the browser
 * keeps the rule "components do not ask the server who they are mid-render".
 */
export interface AdminViewer {
  id: string;
  email: string;
  displayName: string;
}
