import { defineConfig, devices } from "@playwright/test";
import { testEnv } from "./test-support/env";

// End-to-end tests drive a real browser against the app and the local Supabase stack (`supabase start`): `next dev` by
// default, or the production build with E2E_SERVER=start (`pnpm -F web build` first). CI uses the build: `next dev`
// compiles each route on its first request (5 to 18 s on a 2-vCPU runner) and serves every request several times
// slower, so the specs' waits expired there while they pass on a laptop. The server gets the same environment the
// integration tests use (process environment over the local defaults). E2E_BASE_URL points them at a running app
// instead (the Docker stack's edge, http://127.0.0.1:56300): no server is started, and DATABASE_URL must name that
// stack's database.
const ci = Boolean(process.env.CI);
const external = process.env.E2E_BASE_URL;
const port = Number(process.env.E2E_PORT ?? 3217);
const production = process.env.E2E_SERVER === "start";
// The assistant's model (Task 22): the AI SDK mock unless a gateway key is given and AGENT_MODEL is left unset, so the
// smoke drives real turns (workflow, tools, confirmation cards) without a provider. A production server refuses the
// mock unless ALLOW_MOCK_MODEL=1, which only a test stack sets (as docker-compose.test.yml does).
const agentModel = process.env.AGENT_MODEL ?? (process.env.AI_GATEWAY_API_KEY ? undefined : "mock");
const baseURL = external ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  // One Auth service and one database: run the specs one at a time.
  fullyParallel: false,
  workers: 1,
  retries: ci ? 1 : 0,
  // The CI runner shares two vCPUs with the Supabase containers: twice Playwright's defaults (30 s a test, 5 s a wait)
  // there. A test that sets its own budget keeps it.
  timeout: ci ? 60_000 : 30_000,
  expect: { timeout: ci ? 10_000 : 5_000 },
  reporter: ci ? [["github"], ["list"]] : "list",
  use: { baseURL, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(external
    ? {}
    : {
        webServer: {
          command: `pnpm exec next ${production ? "start" : "dev"} --hostname 127.0.0.1 --port ${port}`,
          url: `${baseURL}/login`,
          reuseExistingServer: !ci,
          timeout: 180_000,
          env: {
            ...testEnv(),
            ...(agentModel ? { AGENT_MODEL: agentModel } : {}),
            ...(production && agentModel === "mock" ? { ALLOW_MOCK_MODEL: "1" } : {}),
          },
        },
      }),
});
