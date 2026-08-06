import { router } from "../server";

import { adminRouter } from "./admin";
import { profileRouter } from "./profile";
import { taskRouter } from "./task";

/**
 * The root router. Every feature router is mounted here, and `AppRouter` is the
 * single type the browser client is generated from — there is no hand-written
 * API surface to keep in sync.
 */
export const appRouter = router({
  admin: adminRouter,
  profile: profileRouter,
  task: taskRouter,
});

export type AppRouter = typeof appRouter;
