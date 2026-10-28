import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack (`supabase start`): real Auth (GoTrue), the real
// access token hook and the real database. Only `next/headers` is replaced, by an in-memory cookie jar.
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    include: ["src/**/*.integration.test.ts"],
    passWithNoTests: true,
    setupFiles: ["./test-support/vitest-setup.ts"],
    // All files share one database and one Auth service; run them one at a time.
    fileParallelism: false,
    testTimeout: 60_000,
  },
});
