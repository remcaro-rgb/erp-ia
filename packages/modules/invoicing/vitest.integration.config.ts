import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

// Integration tests run against the local Supabase stack (`supabase start`). The `workflow()` plugin compiles the `"use workflow"` /
// `"use step"` directives and runs the e-invoice workflow in-process (plan 2B Task 17), as the agent's and the kernel's suites do.
//
// The plugin bundles only this package's sources into the step bundle and leaves the workspace packages (kernel, modules, the country
// pack) to Node's own loader, which cannot load their raw TypeScript: test-support/ts-loader.ts registers tsx's.
export default defineConfig({
  plugins: [workflow()],
  test: {
    setupFiles: ["./test-support/ts-loader.ts"],
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
