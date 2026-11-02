import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport } from "@erp/kernel";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let year: number;
let adm: string;
let p1: string;
let p2: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  // The 2026 catalogue is the only one the pack ships: the fixture year is the tax year, whatever today is.
  year = 2026;
  await h.sql`update kernel.companies set tax_id = '900373115-3', legal_name = 'Café del Norte S.A.S.' where id = ${h.companyId}`;
  adm = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  await h.sql`insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) select ${h.companyId}, ${year}, ${`${year}-01-01`}::date, ${`${year}-12-31`}::date where not exists (select 1 from accounting.fiscal_years where company_id = ${h.companyId} and year = ${year})`;
  p1 = await party("900555666", "Proveedor Uno S.A.S.", "5", "11", "11001");
  p2 = await party("900777888", "Proveedor Dos S.A.S.", "1", "05", "05001");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const party = async (document: string, name: string, dv: string, dpto: string | null, mun: string | null) => {
  const [row] = await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, check_digit, legal_name, department_code, municipality_code, dian_status)
    values (${h.companyId}, '{customer,supplier}', '1', '31', ${document}, ${dv}, ${name}, ${dpto}, ${mun}, 'complete') returning id`;
  await markInvoiceReady(h, row!.id, "1");
  return row!.id;
};
const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// Report rows are read cell by cell in the assertions: a loose record keeps them readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
const report = (params: Record<string, unknown>) => runReport(h.deps, h.admin, "accounting.exogena", params, state) as Promise<Out>;
type L = { code: string; debit?: number; credit?: number; party?: string; cc?: boolean; taxCode?: string; taxBase?: number; taxRate?: number };
const post = async (date: string, lines: L[], flags: { opening?: boolean } = {}) => {
  const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
    date, description: "Movimiento de prueba",
    lines: lines.map((l) => ({
      accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.party ? { partyId: l.party } : {}), ...(l.cc ? { costCenterId: adm } : {}),
      ...(l.taxCode ? { taxCode: l.taxCode, taxBase: l.taxBase, taxRate: l.taxRate } : {}),
    })),
  });
  await h.run(h.contador, "accounting.entry.post", { id });
  if (flags.opening) await h.sql`update accounting.entries set is_opening = true where id = ${id}`;
  return id;
};
const debitOf = async (code: string) =>
  Number((await h.sql<{ d: string }[]>`
    select coalesce(sum(l.debit), 0) as d from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
    where l.company_id = ${h.companyId} and a.code like ${`${code}%`} and e.status = 'posted' and not e.is_opening`)[0]!.d);

describe("exógena", () => {
  it("exógena 1001 per-party totals equal the mapped accounts' debit movement, COGS credits to 1435 never count, opening excluded; small parties aggregate under 222222222", async () => {
    // Services bought from P1 with a retention practised; goods bought from P1; a small purchase from P2.
    await post(dateIn(2, 10), [
      { code: "513505", debit: 2_000_000, cc: true },
      { code: "220505", credit: 1_920_000, party: p1 },
      { code: "236540", credit: 80_000, party: p1, taxCode: "RTEFTE_SERVICIOS_4", taxBase: 2_000_000, taxRate: 4 },
    ]);
    await post(dateIn(2, 12), [{ code: "143505", debit: 1_000_000 }, { code: "220505", credit: 1_000_000, party: p1 }]); // party of the document, not on the 1435 line
    await post(dateIn(3, 1), [{ code: "513505", debit: 100_000, cc: true }, { code: "220505", credit: 100_000, party: p2 }]);
    // Cost of sales: a credit to 1435 with no party, which must not count nor be an error.
    await post(dateIn(3, 5), [{ code: "613595", debit: 400_000, cc: true }, { code: "143505", credit: 400_000 }]);
    // An opening entry on a mapped account never counts in a movement format.
    await post(dateIn(1, 2), [{ code: "513505", debit: 900_000, cc: true }, { code: "310505", credit: 900_000 }], { opening: true });

    const out = await report({ year, format: "1001" });
    expect(out.aggregates.errors).toEqual([]);
    const byKey = (concept: string, document: string) => out.rows.find((r) => r.concept === concept && r.party_document === document)!;
    expect(byKey("5004", "900555666")).toMatchObject({ party_name: "Proveedor Uno S.A.S.", pagoded: 2_000_000, retefuente: 80_000, reteivacom: 0, col1: 2_000_000, col2: 80_000 });
    expect(byKey("5007", "900555666")).toMatchObject({ pagoded: 1_000_000, retefuente: 0 });
    // P2 is under the 500.000 threshold: aggregated under the pack's NIT.
    expect(out.rows.some((r) => r.party_document === "900777888")).toBe(false);
    expect(byKey("5004", "222222222")).toMatchObject({ party_name: "CUANTÍAS MENORES", party_document_type: "43", pagoded: 100_000 });
    // Totals per concept equal the mapped accounts' debit movement (opening excluded; the credit to 1435 never counted).
    const total = (concept: string) => out.rows.filter((r) => r.concept === concept).reduce((s, r) => s + r.pagoded, 0);
    expect(total("5004")).toBe(await debitOf("5135"));
    expect(total("5007")).toBe(await debitOf("1435"));
    expect(out.aggregates.col1).toBe(2_000_000 + 1_000_000 + 100_000);
    // A threshold of zero keeps every party.
    const all = await report({ year, format: "1001", threshold: 0 });
    expect(all.rows.some((r) => r.party_document === "900777888")).toBe(true);
    expect(all.rows.some((r) => r.party_document === "222222222")).toBe(false);
    // Another year has no catalogue.
    await expect(report({ year: 2027, format: "1001" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(report({ year, format: "9999" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("1008 includes opening and reports balances at 31-12; the XML is written for a clean report and carries the NIT, rows and cuantías menores", async () => {
    await post(dateIn(1, 2), [{ code: "130505", debit: 2_000_000, party: p1 }, { code: "310505", credit: 2_000_000 }], { opening: true });
    await post(dateIn(4, 2), [{ code: "130505", debit: 6_000_000, party: p1 }, { code: "413595", credit: 6_000_000, cc: true }]);
    await post(dateIn(4, 3), [{ code: "130505", debit: 1_000_000, party: p2 }, { code: "413595", credit: 1_000_000, cc: true }]);
    const balances = await report({ year, format: "1008" });
    expect(balances.aggregates.errors).toEqual([]);
    expect(balances.rows.map((r) => [r.concept, r.party_document, r.saldocxc])).toEqual([["1315", "900555666", 8_000_000], ["1315", "222222222", 1_000_000]]);

    const xml = await h.run<{ fileName: string; xml: string; rows: number }>(h.admin, "accounting.report.exogena_xml", { year, format: "1008" });
    expect(xml.rows).toBe(2);
    expect(xml.fileName).toMatch(/\.xml$/);
    expect(xml.xml).toContain("<Formato>1008</Formato>");
    expect(xml.xml).toContain("<CantReg>2</CantReg>");
    expect(xml.xml).toContain('nid="900555666"');
    expect(xml.xml).toContain('nid="222222222"');
    expect(xml.xml).toContain('saldocxc="8000000"');
    expect(xml.xml.match(/<formato1008 /g)).toHaveLength(2);
  });

  it("XML refuses while an account is unmapped, a line has no party or a party lacks DANE codes or document type", async () => {
    // An expense account no concept covers.
    await post(dateIn(5, 5), [{ code: "519595", debit: 50_000, cc: true }, { code: "111005", credit: 50_000 }]);
    const unmapped = await report({ year, format: "1001" });
    expect(unmapped.aggregates.errors).toEqual([expect.stringContaining("519595")]);
    await expect(h.run(h.admin, "accounting.report.exogena_xml", { year, format: "1001" })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("519595")] });
    // Mapping it clears the error.
    await h.runStepUp(h.admin, "accounting.fiscal_concept_mapping.update", {
      mappings: [{ format: "1001", concept: "5004", accountId: (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '5195'`)[0]!.id }],
    });
    // The movement has no party on a mapped line and none in the entry: an error that names the entry.
    expect((await report({ year, format: "1001" })).aggregates.errors).toEqual([expect.stringMatching(/sin tercero.*519595/i)]);
    const id = await post(dateIn(5, 6), [{ code: "519595", debit: 10, cc: true }, { code: "111005", credit: 10 }]);
    expect(id).toBeTruthy();

    // A party without DANE codes.
    const lacking = await party("900999000", "Sin DANE S.A.S.", "1", null, null);
    await post(dateIn(6, 1), [{ code: "513505", debit: 800_000, cc: true }, { code: "220505", credit: 800_000, party: lacking }]);
    const errors = (await report({ year, format: "1001" })).aggregates.errors as string[];
    expect(errors.some((e) => e.includes("900999000") && e.includes("DANE"))).toBe(true);
    await expect(h.run(h.admin, "accounting.report.exogena_xml", { year, format: "1001" })).rejects.toMatchObject({ code: "invalid_input" });
    // A format with no information is refused with a clear reason.
    await expect(h.run(h.admin, "accounting.report.exogena_xml", { year, format: "1003" })).rejects.toMatchObject({ code: "invalid_input", details: [expect.stringContaining("1003")] });
  });
  it("exógena XML as a restricted user equals the report's rows (restricted accounts aggregated as the report does)", async () => {
    // P2 holds 7.000.000 more on 130510, an account only the admin may see: the admin's 1008 lists P2 on its own row.
    await post(dateIn(7, 1), [{ code: "130510", debit: 7_000_000, party: p2 }, { code: "413595", credit: 7_000_000, cc: true }]);
    const accountId = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '130510'`)[0]!.id;
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId, access: "restricted", grants: [] });
    try {
      const asAdmin = (await runReport(h.deps, h.admin, "accounting.exogena", { year, format: "1008" }, state)) as Out;
      const asContador = (await runReport(h.deps, h.contador, "accounting.exogena", { year, format: "1008" }, state)) as Out;
      expect(asAdmin.rows.map((r) => r.party_document)).toContain("900777888");
      expect(asContador.rows.map((r) => r.party_document)).not.toContain("900777888");
      expect(asContador.aggregates.errors).toEqual([]);

      // The file says what the report shows that user: one entry per row, the same parties, nothing of the restricted account.
      const xml = await h.run<{ xml: string; rows: number }>(h.contador, "accounting.report.exogena_xml", { year, format: "1008" });
      expect(xml.rows).toBe(asContador.rows.length);
      expect(xml.xml.match(/<formato1008 /g)).toHaveLength(asContador.rows.length);
      for (const row of asContador.rows) expect(xml.xml).toContain(`nid="${row.party_document}"`);
      expect(xml.xml).not.toContain('nid="900777888"');
      expect(xml.xml).toContain(`saldocxc="${asContador.rows.find((r) => r.party_document === "900555666")!.saldocxc}"`);
      // The admin's file carries the row the restricted user's cannot.
      expect((await h.run<{ xml: string }>(h.admin, "accounting.report.exogena_xml", { year, format: "1008" })).xml).toContain('nid="900777888"');
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId, access: "open", grants: [] });
    }
  });
});
