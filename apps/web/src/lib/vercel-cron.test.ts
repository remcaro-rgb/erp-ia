import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Final review M4: Vercel reads vercel.json from the project's root directory, which for this monorepo is `apps/web`
// (README › Deploy on Vercel). Every cron it declares must be a route of this app that answers GET.
const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

describe("vercel.json", () => {
  it("lives in the Next app, not at the repository root", () => {
    expect(existsSync(`${webRoot}vercel.json`)).toBe(true);
    expect(existsSync(`${repoRoot}vercel.json`)).toBe(false);
  });

  it("drives the outbox tick on a schedule (daily while the Vercel account is on the Hobby plan), and each cron path is a GET route of the app", () => {
    const config = JSON.parse(readFileSync(`${webRoot}vercel.json`, "utf8")) as { crons: { path: string; schedule: string }[] };
    const tick = config.crons.find((cron) => cron.path === "/api/internal/outbox/tick");
    // Five cron fields; once a day on Hobby (Vercel refuses more there), "* * * * *" once the account is on Pro.
    expect(tick?.schedule.split(" ")).toHaveLength(5);
    expect(["0 5 * * *", "* * * * *"]).toContain(tick?.schedule);
    for (const cron of config.crons) {
      const route = `${webRoot}src/app${cron.path}/route.ts`;
      expect(existsSync(route), route).toBe(true);
      expect(readFileSync(route, "utf8")).toMatch(/export (async function|const) GET\b/);
    }
  });
});
