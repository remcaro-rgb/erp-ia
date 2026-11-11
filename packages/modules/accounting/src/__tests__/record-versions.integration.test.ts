import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Versiones of a documento (entity types spec §8, D18, rule 14; Phase 2A.5 Task 15 round 1, migration 0051): kernel.record_versions
// answers the snapshots with every header and line field the caller may not see replaced by the mask in SQL, so the raw value never
// reaches the application. kernel.record_authors names users by their name only, never by an e-mail the viewer may not see.
const MASK = "••••••••";
let h: AccountingHarness;
let year: number;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId}`;
  await h.cleanup();
});

type Version = { version: number; status: string; header: Record<string, unknown>; lines: Record<string, unknown>[]; reason: string | null; by_name: string | null };
const versions = (caller: typeof h.contador, id: string) =>
  withClaims(h.sql, caller.claims, (tx) => tx<Version[]>`select * from kernel.record_versions('accounting.entry', ${id}::uuid)`);

describe("kernel.record_versions (D18 in SQL)", () => {
  it("masks hidden header and line fields in every version, and keeps visible ones", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-02-15`,
      description: "Pago confidencial",
      lines: [
        { accountCode: "111005", debit: 100, credit: 0 },
        { accountCode: "310505", debit: 0, credit: 100 },
      ],
    });
    await h.run(h.contador, "accounting.entry.save", { id });
    const before = await versions(h.contador, id);
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(before[0]!.header.description).toBe("Pago confidencial");

    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values
      (${h.companyId}, ${h.contador.roleId}, 'accounting.entry', 'description', 'hidden'),
      (${h.companyId}, ${h.contador.roleId}, 'accounting.entry_line', 'debit', 'masked')`;
    const after = await versions(h.contador, id);
    expect(after.map((v) => v.version)).toEqual(before.map((v) => v.version));
    for (const v of after) {
      expect(v.header.description).toBe(MASK);
      expect(v.header.date).toBeTruthy();
      expect(v.lines.length).toBe(2);
      for (const line of v.lines) {
        expect(line.debit).toBe(MASK);
        expect(line.credit).not.toBe(MASK);
      }
    }
    // The raw text appears nowhere in what the caller gets.
    expect(JSON.stringify(after)).not.toContain("Pago confidencial");
  });

  it("answers nothing for an unknown entity or another record id", async () => {
    const none = await withClaims(h.sql, h.contador.claims, (tx) => tx`select * from kernel.record_versions('accounting.nothing', ${"01923456-0000-7000-8000-000000000000"}::uuid)`);
    expect(none).toEqual([]);
  });

  it("record_authors never answers a user's e-mail", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-02-16`,
      description: "Sin nombre",
      lines: [
        { accountCode: "111005", debit: 50, credit: 0 },
        { accountCode: "310505", debit: 0, credit: 50 },
      ],
    });
    await h.sql`update kernel.users set full_name = null where id = ${h.contador.userId}`;
    const [row] = await withClaims(h.sql, h.contador.claims, (tx) => tx<{ created_by_name: string | null }[]>`select created_by_name from kernel.record_authors('accounting.entry', ${id}::uuid)`);
    expect(row!.created_by_name).toBeNull();
  });
});
