import { config as loadEnv } from "dotenv";
import { defineConfig, devices } from "@playwright/test";

loadEnv({ path: ".env.local", quiet: true });

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],

  /**
   * Budgets sized for `next dev`, not for the assertions.
   *
   * The suite runs `fullyParallel` against **one** dev server, which compiles a
   * route the first time anybody asks for it. Several workers reaching a cold
   * route at once queue behind the same compile, and each request also pays for
   * a live `auth.getUser()` plus the proxy's per-request `profiles.status` read
   * that AGENTS.md accepts as the cost of not trusting the JWT. Phase 2 added
   * three more routes to compile and pushed the last project to run — `mobile`,
   * dark theme — past the 30s default on `page.goto("/settings")`, a route it
   * does not touch. Running the same spec alone passed, which is what says
   * "contention" rather than "regression".
   *
   * Nothing is weakened: the assertions are unchanged, they are given longer to
   * become true, and a genuine failure still fails — just later. Against a
   * production build these would all be an order of magnitude under budget; the
   * harness deliberately drives `pnpm dev` so a failure is debuggable in the
   * same server you develop in.
   */
  timeout: 120_000,
  expect: { timeout: 20_000 },

  use: { baseURL },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 14"] } },
  ],
  webServer: {
    command: "pnpm dev",
    url: baseURL,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
