import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let journalId: string;
let partyId: string;
let costCenterId: string;
let year: number;
beforeAll(async () => {
  h = await accountingHarness({ companies: 2 });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  journalId = (await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`)[0]!.id;
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Cliente de prueba S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
  costCenterId = (await h.sql<{ id: string }[]>`
    insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

type Line = { code: string; debit?: number; credit?: number; party?: boolean | string; costCenter?: boolean; taxCode?: string; taxBase?: number; dueDate?: string };
/** Inserts a comprobante straight into the tables (the processes arrive in Tasks 18–19) and leaves it `posted` or `draft`. */
async function entry(date: string, lines: Line[], opts: { status?: "draft" | "posted"; source?: string } = {}) {
  const status = opts.status ?? "posted";
  const [e] = await h.sql<{ id: string }[]>`
    insert into accounting.entries (company_id, journal_id, date, description, source_entity, source_record_id)
    values (${h.companyId}, ${journalId}, ${date}, 'Prueba', ${opts.source ? "sales.invoice" : null}, ${opts.source ?? null}) returning id`;
  let no = 0;
  for (const l of lines) {
    no += 1;
    await h.sql`
      insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, party_id, cost_center_id, debit, credit, tax_code, tax_base, due_date)
      values (${h.companyId}, ${e!.id}, ${no}, ${await accountId(l.code)}, ${l.party ? (typeof l.party === "string" ? l.party : partyId) : null}, ${l.costCenter ? costCenterId : null},
              ${l.debit ?? 0}, ${l.credit ?? 0}, ${l.taxCode ?? null}, ${l.taxBase ?? null}, ${l.dueDate ?? null})`;
  }
  if (status === "posted") {
    const [p] = await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and ${date}::date between starts_on and ends_on`;
    const [n] = await h.sql<{ n: string }[]>`select accounting.next_entry_number(${journalId}) as n`;
    await h.sql`update accounting.entries set status = 'posted', number = ${n!.n}, period_id = ${p!.id}, posted_at = now() where id = ${e!.id}`;
  }
  return e!.id;
}

const as = <T>(claims: typeof h.admin.claims, fn: (tx: typeof h.sql) => Promise<T>) => withClaims(h.sql, claims, (tx) => fn(tx as unknown as typeof h.sql));
const restrict = async (code: string, grants: object[], access: "open" | "restricted" = "restricted") =>
  h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId(code), access, grants });

describe("published views", () => {
  it("v_ledger_lines hides restricted lines for a user without view and shows them to one with view; row counts differ by the restricted lines", async () => {
    await entry(dateIn(3), [{ code: "510506", debit: 100 }, { code: "111005", credit: 100 }]);
    await entry(dateIn(3, 20), [{ code: "510506", debit: 40 }, { code: "111005", credit: 40 }], { status: "draft" });
    const count = (claims: typeof h.admin.claims) =>
      as(claims, async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from accounting.v_ledger_lines where company_id = ${h.companyId}`)[0]!.n);
    const before = await count(h.auxiliar.claims);
    expect(before).toBe(4); // posted and draft lines both appear
    await restrict("5105", [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }]);
    expect(await count(h.auxiliar.claims)).toBe(2);
    expect(await count(h.contador.claims)).toBe(4);
    expect(await count(h.admin.claims)).toBe(4);
    const codes = await as(h.auxiliar.claims, async (tx) => (await tx<{ account_code: string; account_class: string; account_group: string }[]>`
      select distinct account_code, account_class, account_group from accounting.v_ledger_lines`).map((r) => r.account_code));
    expect(codes).toEqual(["111005"]);
    // The totals of what the auxiliar can see carry no figure of the restricted account.
    const [sum] = await as(h.auxiliar.claims, (tx) => tx<{ debit: string; credit: string }[]>`select sum(debit) as debit, sum(credit) as credit from accounting.v_ledger_lines`);
    expect(Number(sum!.debit)).toBe(0);
    expect(Number(sum!.credit)).toBe(140);
    await restrict("5105", [], "open");
  });

  it("v_ledger_lines carries the §4.16 columns: net, signed net by nature, party, dimensions, fiscal year and Fuente", async () => {
    const id = await entry(dateIn(4), [{ code: "130505", debit: 500, party: true, costCenter: true, dueDate: dateIn(5) }, { code: "413505", credit: 500, costCenter: true }]);
    const rows = await as(h.admin.claims, (tx) => tx<Record<string, unknown>[]>`
      select * from accounting.v_ledger_lines where entry_id = ${id} order by line_no`);
    expect(rows[0]).toMatchObject({
      journal_code: "NC", status: "posted", fiscal_year: year, account_code: "130505", account_class: "1", account_group: "13", party_document: "900111222",
      party_name: "Cliente de prueba S.A.S.", cost_center_code: "ADM", cost_center_name: "Administración", net: "500.0000", signed_net: "500.0000",
    });
    expect(rows[1]).toMatchObject({ account_code: "413505", net: "-500.0000", signed_net: "500.0000" });
  });

  it("v_entry_lines masks a restricted line (nulls + is_restricted) while the entry totals stay", async () => {
    const id = await entry(dateIn(6), [{ code: "510506", debit: 70, costCenter: true }, { code: "111005", credit: 70 }]);
    await restrict("5105", [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false }]);
    const lines = await as(h.auxiliar.claims, (tx) => tx<Record<string, unknown>[]>`
      select line_no, account_id, debit, credit, debit_doc, credit_doc, cost_center_id, description, is_restricted from accounting.v_entry_lines where entry_id = ${id} order by line_no`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({ line_no: 1, account_id: null, debit: null, credit: null, debit_doc: null, credit_doc: null, cost_center_id: null, description: null, is_restricted: true });
    expect(lines[1]).toMatchObject({ line_no: 2, account_id: await accountId("111005"), credit: "70.0000", is_restricted: false });
    const [header] = await as(h.auxiliar.claims, (tx) => tx<{ total_debit: string; total_credit: string }[]>`select total_debit, total_credit from accounting.v_entries where id = ${id}`);
    expect(header).toEqual({ total_debit: "70.0000", total_credit: "70.0000" });
    const open = await as(h.contador.claims, (tx) => tx<{ is_restricted: boolean; debit: string | null }[]>`select is_restricted, debit from accounting.v_entry_lines where entry_id = ${id} and line_no = 1`);
    expect(open[0]).toEqual({ is_restricted: false, debit: "70.0000" });
    await restrict("5105", [], "open");
  });

  it("v_account_balances aggregates posted lines only, per period and dimension", async () => {
    const acct = await accountId("513505");
    await entry(dateIn(7), [{ code: "513505", debit: 30, costCenter: true }, { code: "111005", credit: 30 }]);
    await entry(dateIn(7, 20), [{ code: "513505", debit: 12, costCenter: true }, { code: "111005", credit: 12 }]);
    await entry(dateIn(8), [{ code: "513505", debit: 5, costCenter: true }, { code: "111005", credit: 5 }]);
    await entry(dateIn(8, 20), [{ code: "513505", debit: 999 }, { code: "111005", credit: 999 }], { status: "draft" });
    const rows = await as(h.admin.claims, (tx) => tx<{ period_number: number; cost_center_id: string | null; debit: string; credit: string }[]>`
      select p.number as period_number, b.cost_center_id, b.debit, b.credit
      from accounting.v_account_balances b join accounting.periods p on p.id = b.period_id
      where b.account_id = ${acct} order by p.number`);
    expect(rows).toEqual([
      { period_number: 7, cost_center_id: costCenterId, debit: "42.0000", credit: "0.0000" },
      { period_number: 8, cost_center_id: costCenterId, debit: "5.0000", credit: "0.0000" },
    ]);
  });

  it("open_items applies receipts FIFO by due date per party and account", async () => {
    // Invoices 100 (due d1) and 200 (due d2), receipt 150 → the first is closed and the second keeps 150.
    const [other] = await h.sql<{ id: string }[]>`
      insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${h.companyId}, '{customer}', '2', '13', '900333444', 'Otro cliente S.A.S.', 'errors') returning id`;
    await markInvoiceReady(h, other!.id, "2");
    const p2 = other!.id;
    const d1 = dateIn(9, 10);
    const d2 = dateIn(9, 25);
    const first = await entry(dateIn(9, 1), [{ code: "130505", debit: 100, party: p2, dueDate: d1 }, { code: "413505", credit: 100 }]);
    const second = await entry(dateIn(9, 2), [{ code: "130505", debit: 200, party: p2, dueDate: d2 }, { code: "413505", credit: 200 }]);
    await entry(dateIn(9, 12), [{ code: "111005", debit: 150 }, { code: "130505", credit: 150, party: p2 }]);
    const items = await as(h.admin.claims, (tx) => tx<{ entry_id: string; original: string; open: string; due_date: string }[]>`
      select entry_id, original, open, due_date::text from accounting.v_open_items where party_id = ${p2} and entry_id in (${first}, ${second}) order by due_date`);
    expect(items.map((i) => [i.entry_id, Number(i.original), Number(i.open)])).toEqual([[first, 100, 0], [second, 200, 150]]);
    // An earlier as-of date leaves the receipt out.
    const early = await as(h.admin.claims, (tx) => tx<{ entry_id: string; open: string }[]>`
      select entry_id, open from accounting.open_items(${h.companyId}, ${dateIn(9, 11)}::date) where entry_id in (${first}, ${second}) order by due_date`);
    expect(early.map((i) => Number(i.open))).toEqual([100, 200]);
  });

  it("open_items on a payable account applies payments to the credit lines", async () => {
    const bill = await entry(dateIn(10, 1), [{ code: "513505", debit: 80 }, { code: "220505", credit: 80, party: true, dueDate: dateIn(11, 1) }]);
    await entry(dateIn(10, 5), [{ code: "220505", debit: 30, party: true }, { code: "111005", credit: 30 }]);
    const [item] = await as(h.admin.claims, (tx) => tx<{ original: string; open: string }[]>`select original, open from accounting.v_open_items where entry_id = ${bill}`);
    expect([Number(item!.original), Number(item!.open)]).toEqual([80, 50]);
  });

  it("v_entries_for_source and v_tax_lines publish the document link and the tax lines", async () => {
    const source = "0192b4c0-0000-7000-8000-000000000001";
    const id = await entry(dateIn(11), [
      { code: "130505", debit: 119, party: true },
      { code: "413505", credit: 100 },
      { code: "240801", credit: 19, party: true, taxCode: "IVA_19", taxBase: 100 },
    ], { source });
    const [link] = await as(h.admin.claims, (tx) => tx<{ entry_id: string; number: string; status: string; total_debit: string }[]>`
      select entry_id, number, status, total_debit from accounting.v_entries_for_source where source_entity = 'sales.invoice' and source_record_id = ${source}`);
    expect(link).toMatchObject({ entry_id: id, status: "posted", total_debit: "119.0000" });
    const tax = await as(h.admin.claims, (tx) => tx<{ party_id: string; tax_code: string; tax_base: string; credit: string }[]>`select party_id, tax_code, tax_base, credit from accounting.v_tax_lines where entry_id = ${id}`);
    expect(tax).toEqual([{ party_id: partyId, tax_code: "IVA_19", tax_base: "100.0000", credit: "19.0000" }]);
  });

  it("tenant isolation: company B sees no row of company A in any of the published views", async () => {
    const companyB = h.seed.companies[1]!.id;
    const claimsB = h.seed.claimsFor(h.seed.users.both, companyB);
    for (const view of ["v_entry_lines", "v_account_balances", "v_entries_for_source", "v_tax_lines", "v_open_items", "v_ledger_lines"]) {
      const a = await as(h.admin.claims, async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(`accounting.${view}`)}`)[0]!.n);
      expect(a, `${view} has rows for company A`).toBeGreaterThan(0);
      const b = await as(claimsB, async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from ${tx(`accounting.${view}`)}`)[0]!.n);
      expect(b, `${view} leaks to company B`).toBe(0);
    }
  });
});
