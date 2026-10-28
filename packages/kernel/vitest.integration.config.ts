import { defineConfig } from "vitest/config";

// Integration tests run against the local Supabase stack; later tasks add them.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts", "src/**/rls.test.ts"],
    passWithNoTests: true,
  },
});
