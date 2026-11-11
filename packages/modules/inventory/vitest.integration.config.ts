import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack (`supabase start`).
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    // All files share one database; run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    // Fixture hooks seed through many round trips; against a hosted database (option 1, 2026-10-29) they need minutes.
    hookTimeout: 180_000,
  },
});
