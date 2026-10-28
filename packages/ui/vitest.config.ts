import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.integration.test.ts", "node_modules/**"],
  },
});
