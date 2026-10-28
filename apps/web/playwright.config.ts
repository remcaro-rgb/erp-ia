import { defineConfig, devices } from "@playwright/test";
import { testEnv } from "./test-support/env";

// End-to-end tests drive a real browser against `next dev` and the local Supabase stack (`supabase start`).
// The server gets the same environment the integration tests use (process environment over the local defaults).
const port = Number(process.env.E2E_PORT ?? 3217);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // One Auth service and one database: run the specs one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: testEnv(),
  },
});
