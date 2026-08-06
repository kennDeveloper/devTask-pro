import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Unit tests only. `tests/integration/**` is excluded here because those specs
// need a live local Supabase stack (`pnpm db:start`), which CI does not have —
// run them with `pnpm test:integration` against vitest.integration.config.ts.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
    exclude: [
      "**/node_modules/**",
      "**/e2e/**",
      "**/tests/integration/**",
      ".verify/**",
    ],
  },
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
});
