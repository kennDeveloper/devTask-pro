import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "**/e2e/**", ".verify/**"],
  },
  resolve: { alias: { "@": resolve(__dirname, "./src") } },
});
