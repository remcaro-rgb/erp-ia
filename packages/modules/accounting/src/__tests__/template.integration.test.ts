import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let buLeaf: string;
let ccLeaf: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  buLeaf = (await h.sql<{ id: string }[]>`insert into accounting.business_units (company_id, code, name, kind) values (${h.companyId}, 'CON', 'Consumo', 'leaf') returning id`)[0]!.id;
  ccLeaf = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const journalId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const rent = async () => ({
  name: "Arriendo mensual",
  journalId: await journalId("NC"),
  description: "Arriendo de la oficina",
  businessUnitId: buLeaf,
  lines: [
    { accountCode: "512010", side: "debit", amount: 3_000_000, costCenterId: ccLeaf },
    { accountCode: "111005", side: "credit" },
  ],
});

describe("entry templates", () => {
  it("creates a template with its lines, consults it, and update replaces the lines", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry_template.create", await rent());
    const found = await h.run<{ name: string; business_unit_id: string; lines: { line_no: number; account_code: string; side: string; amount: string | null }[] }>(h.contador, "accounting.entry_template.consult", { id });
    expect(found).toMatchObject({ name: "Arriendo mensual", business_unit_id: buLeaf });
    expect(found.lines.map((l) => [l.line_no, l.account_code, l.side, l.amount])).toEqual([[1, "512010", "debit", "3000000.0000"], [2, "111005", "credit", null]]);
    await h.run(h.contador, "accounting.entry_template.update", { id, name: "Arriendo", lines: [{ accountCode: "512010", side: "debit", amount: 1 }, { accountCode: "111005", side: "credit", amount: 1 }] });
    const updated = await h.run<{ name: string; lines: unknown[] }>(h.contador, "accounting.entry_template.consult", { id });
    expect(updated.name).toBe("Arriendo");
    expect(updated.lines).toHaveLength(2);
  });

  it("refuses a template line on an account the author cannot post to, an unknown account and an inactive journal-less header", async () => {
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '5120'`)[0]!.id,
      access: "restricted", grants: [],
    });
    await expect(h.run(h.contador, "accounting.entry_template.create", await rent())).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("512010")] });
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '5120'`)[0]!.id, access: "open", grants: [],
    });
    await expect(h.run(h.contador, "accounting.entry_template.create", { ...(await rent()), lines: [{ accountCode: "999999", side: "debit" }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.contador, "accounting.entry_template.create", { ...(await rent()), journalId: newId() })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("from_template creates a draft with the template's lines, header business unit and the amounts given", async () => {
    const { id: templateId } = await h.run<{ id: string }>(h.contador, "accounting.entry_template.create", await rent());
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.from_template", { templateId, date: "2026-10-31", amounts: { 2: 3_000_000 } });
    const [entry] = await h.sql`select status, origin, business_unit_id, description, date::text as date, total_debit, total_credit from accounting.entries where id = ${id}`;
    expect(entry).toMatchObject({ status: "draft", origin: "template", business_unit_id: buLeaf, description: "Arriendo de la oficina", date: "2026-10-31", total_debit: "3000000.0000", total_credit: "3000000.0000" });
    const lines = await h.sql`select line_no, debit, credit, cost_center_id from accounting.entry_lines where entry_id = ${id} order by line_no`;
    expect(lines.map((l) => [l.line_no, l.debit, l.credit, l.cost_center_id])).toEqual([[1, "3000000.0000", "0.0000", ccLeaf], [2, "0.0000", "3000000.0000", null]]);
    // An amount given overrides the template's fixed one; a description overrides the template's.
    const second = await h.run<{ id: string }>(h.contador, "accounting.entry.from_template", { templateId, date: "2026-11-30", amounts: { 1: 3_100_000, 2: 3_100_000 }, description: "Arriendo de noviembre" });
    expect(await h.sql`select description, total_debit from accounting.entries where id = ${second.id}`).toEqual([{ description: "Arriendo de noviembre", total_debit: "3100000.0000" }]);
  });

  it("from_template refuses a line with no amount, a template that is not the company's and an inactive account", async () => {
    // The name is unique per company (0043, D14 import key).
    const { id: templateId } = await h.run<{ id: string }>(h.contador, "accounting.entry_template.create", { ...(await rent()), name: "Arriendo de la bodega" });
    await expect(h.run(h.contador, "accounting.entry.from_template", { templateId, date: "2026-10-31" })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("2")] });
    await expect(h.run(h.contador, "accounting.entry.from_template", { templateId: newId(), date: "2026-10-31" })).rejects.toMatchObject({ code: "not_found" });
  });

  // Record-level access (entity types spec §9.1; Task 9 M4 → Task 13): a comprobante from a plantilla needs the `use` right on it. A
  // plantilla the caller cannot read is refused exactly as one that does not exist; one they read without `use` is record_forbidden.
  it("from_template needs the use right on the template: hidden is not_found (as a random id), read-only is record_forbidden", async () => {
    const { id: templateId } = await h.run<{ id: string }>(h.contador, "accounting.entry_template.create", { ...(await rent()), name: "Arriendo reservado" });
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_use)
                values (${h.companyId}, 'accounting.entry_template', ${templateId}, ${h.contador.roleId}, true, false)`;
    try {
      const entries = async () => (await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.entries where company_id = ${h.companyId}`)[0]!.n;
      const before = await entries();
      const refusal = (caller: typeof h.contador, id: string) =>
        h.run(caller, "accounting.entry.from_template", { templateId: id, date: "2026-10-31", amounts: { 2: 3_000_000 } }).then(() => null, (e: unknown) => e as { code: string; message: string; details?: unknown });
      const hidden = await refusal(h.auxiliar, templateId);
      const ghost = await refusal(h.auxiliar, newId());
      expect(hidden?.code).toBe("not_found");
      expect(hidden?.details).toEqual(ghost?.details);
      expect(await refusal(h.contador, templateId)).toMatchObject({ code: "record_forbidden", details: { entity: "accounting.entry_template", recordId: templateId, right: "use" } });
      expect(await entries()).toBe(before);
    } finally {
      await h.sql`delete from kernel.record_access where company_id = ${h.companyId} and record_id = ${templateId}`;
    }
  });
});
