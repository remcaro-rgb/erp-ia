import { defineConfig, devices } from "@playwright/test";
import { testEnv } from "./test-support/env";

// End-to-end tests drive a real browser against `next dev` and the local Supabase stack (`supabase start`).
// The server gets the same environment the integration tests use (process environment over the local defaults).
// E2E_BASE_URL points them at a running app instead (the Docker stack's edge, http://127.0.0.1:56300): no server is
// started, and DATABASE_URL must name that stack's database.
const external = process.env.E2E_BASE_URL;
const port = Number(process.env.E2E_PORT ?? 3217);
// The assistant's model (Task 22): the AI SDK mock unless a gateway key is given and AGENT_MODEL is left unset, so the
// smoke drives real turns (workflow, tools, confirmation cards) without a provider.
const agentModel = process.env.AGENT_MODEL ?? (process.env.AI_GATEWAY_API_KEY ? undefined : "mock");
const baseURL = external ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // One Auth service and one database: run the specs one at a time.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(external
    ? {}
    : {
        webServer: {
          command: `pnpm exec next dev --hostname 127.0.0.1 --port ${port}`,
          url: `${baseURL}/login`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: { ...testEnv(), ...(agentModel ? { AGENT_MODEL: agentModel } : {}) },
        },
      }),
});
