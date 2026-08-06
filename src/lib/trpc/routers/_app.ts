import { router } from "../server";

import { profileRouter } from "./profile";
import { seriesRouter } from "./series";
import { tagRouter } from "./tag";
import { taskRouter } from "./task";

/**
 * The root router. Every feature router is mounted here, and `AppRouter` is the
 * single type the browser client is generated from — there is no hand-written
 * API surface to keep in sync.
 */
export const appRouter = router({
  profile: profileRouter,
  task: taskRouter,
  series: seriesRouter,
  tag: tagRouter,
});

export type AppRouter = typeof appRouter;
