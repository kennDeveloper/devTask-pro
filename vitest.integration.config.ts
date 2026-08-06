import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config } from "dotenv";

// Integration specs run against the LIVE local Supabase stack (`pnpm db:start`).
// Node environment — these talk to Postgres and the Supabase admin API, not the DOM.
config({ path: ".env.local" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
});
