import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getServiceDb } from "@erp/kernel";
import { DEMO_COMPANY_ID } from "../demo/accounts";
import { SAMPLE_COMPROBANTES } from "../demo/accounting";

// The whole demo seed against the local stack (owner order 2026-11-02): `DEMO_SEED=1 pnpm db:seed` must finish, with a posted
// and balanced opening and the October sample comprobantes posted. It writes the demo company, so it runs only on request:
//   pnpm db:reset && cd scripts && DEMO_SEED=1 pnpm exec vitest run seed-demo
const enabled = process.env.DEMO_SEED === "1";
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

describe.skipIf(!enabled)("DEMO_SEED=1 pnpm db:seed", () => {
  it("completes, with the 2026 opening posted and balanced and the October sample comprobantes posted", async () => {
    execFileSync("pnpm", ["db:seed"], { cwd: ROOT, env: { ...process.env, DEMO_SEED: "1" }, stdio: "inherit" });
    await import("../env");
    const sql = getServiceDb();
    try {
      const [opening] = await sql<{ debit: string; credit: string; lines: number }[]>`
        select sum(l.debit)::text as debit, sum(l.credit)::text as credit, count(*)::int as lines
        from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id
        where e.company_id = ${DEMO_COMPANY_ID} and e.is_opening and e.status = 'posted'`;
      expect(opening!.lines).toBeGreaterThan(0);
      expect(Number(opening!.debit)).toBeGreaterThan(0);
      expect(Number(opening!.debit)).toBe(Number(opening!.credit));
      const posted = await sql<{ description: string }[]>`
        select description from accounting.entries
        where company_id = ${DEMO_COMPANY_ID} and status = 'posted' and description = any(${SAMPLE_COMPROBANTES.map((c) => c.description)})`;
      expect(posted.map((r) => r.description).sort()).toEqual(SAMPLE_COMPROBANTES.map((c) => c.description).sort());
    } finally {
      await sql.end();
    }
  }, 600_000);
});
