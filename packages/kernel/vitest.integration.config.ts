import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

// Integration tests run against the local Supabase stack (`supabase start`). The `workflow()`
// plugin compiles the `"use workflow"` / `"use step"` directives and runs workflows in-process.
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    // All files share one database; run them one at a time.
    fileParallelism: false,
    // Workflows retry and hop between steps; give them room.
    testTimeout: 60_000,
    // Fixture hooks seed through many round trips; against a hosted database (option 1, 2026-10-29) they need minutes.
    hookTimeout: 180_000,
  },
});
