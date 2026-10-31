import { defineConfig } from "@playwright/test";

// The screenshots of the user guides (docs/user-guide/es-419/contabilidad/img): `pnpm -F web guide:shots` against a running app
// (E2E_BASE_URL) on a freshly seeded demo company. It is not part of `pnpm -F web e2e` (another testDir), so CI never rewrites the images.
export default defineConfig({
  testDir: "./guide-shots",
  testMatch: "*.shots.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100",
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    locale: "es-419",
    timezoneId: "America/Bogota",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
