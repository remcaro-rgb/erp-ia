import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack (`supabase start`).
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    // All files share one database; run them one at a time.
    fileParallelism: false,
  },
});
