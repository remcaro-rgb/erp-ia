import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack (`supabase start`): real Auth (GoTrue), the real
// access token hook and the real database. Only `next/headers` is replaced, by an in-memory cookie jar.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside a React server build; the tests run server code in plain Node.
      "server-only": fileURLToPath(new URL("./test-support/server-only-stub.ts", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    setupFiles: ["./test-support/vitest-setup.ts"],
    // All files share one database and one Auth service; run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
    // Fixture hooks seed through many round trips; against a hosted database (option 1, 2026-10-29) they need minutes.
    hookTimeout: 180_000,
  },
});
