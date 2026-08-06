/**
 * The types every component in this directory shares.
 *
 * They live here rather than in a component file for the reason AGENTS.md
 * gives: if you have to scroll past declarations to reach the JSX, the
 * declarations are in the wrong file.
 */

import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

import type { AppRouter } from "@/lib/trpc/routers/_app";

/**
 * One task, exactly as the browser receives it.
 *
 * Inferred from the router rather than imported as `PublicTask` from
 * `routers/task.ts`, which is the same call `settings-screen.tsx` makes and for
 * the same reason: `routers/task.ts` reaches `withUser` and the `postgres`
 * driver, and only a *type* import keeps that out of the client bundle. Reading
 * it off `AppRouter` — which is already a type-only import — removes the
 * possibility of someone later turning it into a value import by accident.
 *
 * Note what this type says and a server-side `TaskOccurrence` does not:
 * `deadlineAt`, `completedAt`, `createdAt` and `updatedAt` are **strings**. The
 * tRPC link has no transformer, so a `Date` never survives the wire, and
 * `toPublicTask` serialises them so the inferred type tells the truth.
 * `occursOn` is a bare `YYYY-MM-DD` calendar date and must stay one.
 */
export type Task = inferRouterOutputs<AppRouter>["task"]["list"][number];

/** The payload `task.create` accepts, as the client must shape it. */
export type TaskCreateInput = inferRouterInputs<AppRouter>["task"]["create"];

/** The patch `task.update` accepts. Every field but `id` is optional. */
export type TaskUpdateInput = inferRouterInputs<AppRouter>["task"]["update"];

/**
 * Everything time-related, resolved **once on the server** and handed down.
 *
 * This is acceptance criterion 19 expressed as a prop. No component under
 * `src/components/tasks/` calls `new Date()`, reads `Intl`'s ambient timezone,
 * or asks the browser what day it is — all three differ between the render that
 * produced the HTML and the render that hydrates it, and the disagreement
 * surfaces as a hydration error or, worse, as a task quietly filed on the wrong
 * day. The page resolves these from `profiles.timezone` and passes them in.
 *
 * Grouped into one object deliberately: the three are only ever correct
 * together. `today` must be `todayInZone(timeZone, now)`, and three loose props
 * invite a caller to refresh one without the others.
 */
export interface TaskClock {
  /**
   * The instant the page was rendered. Overdue is judged against this and
   * nothing else, so every list on a page agrees about "late".
   */
  now: Date;
  /** The account holder's IANA zone. Every date on screen is rendered in it. */
  timeZone: string;
  /** `todayInZone(timeZone, now)` — the user's calendar day, as `YYYY-MM-DD`. */
  today: string;
}
