import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport } from "@erp/kernel";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

let h: AccountingHarness;
let year: number;
let adm: string;
let partyA: string;
let partyB: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  adm = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  const party = async (document: string, name: string) => {
    const [row] = await h.sql<{ id: string }[]>`
      insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
      values (${h.companyId}, '{customer,supplier}', '2', '13', ${document}, ${name}, 'errors') returning id`;
    await markInvoiceReady(h, row!.id, "2");
    return row!.id;
  };
  partyA = await party("900111222", "Cliente A S.A.S.");
  partyB = await party("900333444", "Proveedor B S.A.S.");
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// Report rows are read cell by cell in the assertions: a loose record keeps them readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
const report = (id: string, params: Record<string, unknown>) => runReport(h.deps, h.admin, id, params, state) as Promise<Out>;
const post = async (date: string, lines: { code: string; debit?: number; credit?: number; party?: string; cc?: boolean; dueDate?: string }[]) => {
  const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
    date, description: "Movimiento de prueba",
    lines: lines.map((l) => ({
      accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.party ? { partyId: l.party } : {}), ...(l.cc ? { costCenterId: adm } : {}), ...(l.dueDate ? { dueDate: l.dueDate } : {}),
    })),
  });
  await h.run(h.contador, "accounting.entry.save", { id });
  return id;
};
const invoice = (date: string, amount: number, dueDate: string) =>
  post(date, [{ code: "130505", debit: amount, party: partyA, dueDate }, { code: "413595", credit: amount, cc: true }]);

describe("control reports", () => {
  const asOf = () => dateIn(6, 30);

  it("aging totals per party equal the account's balance for that party at as_of; buckets by days after due_date", async () => {
    await invoice(dateIn(5, 20), 100, dateIn(6, 20)); // 10 days past due
    await invoice(dateIn(3, 1), 200, dateIn(5, 1)); // 60 days
    await invoice(dateIn(6, 1), 400, dateIn(7, 15)); // not due
    await invoice(dateIn(1, 10), 800, dateIn(3, 1)); // 121 days
    await post(dateIn(6, 10), [{ code: "111005", debit: 150 }, { code: "130505", credit: 150, party: partyA }]); // applied FIFO to the oldest
    await post(dateIn(5, 25), [{ code: "513505", debit: 300, cc: true }, { code: "220505", credit: 300, party: partyB, dueDate: dateIn(6, 1) }]); // 29 days

    // «Incluir en el total»: the total adds what is not yet due, so it is the account's balance (owner 2026-11-11).
    const receivable = await report("accounting.aging", { kind: "receivable", asOf: asOf(), notDue: "include" });
    expect(receivable.rows).toHaveLength(1);
    expect(receivable.rows[0]).toMatchObject({ party_name: "Cliente A S.A.S.", not_due: 400, b1: 100, b2: 200, b3: 0, over: 650, total: 1_350 });
    expect(receivable.aggregates).toMatchObject({ not_due: 400, b1: 100, b2: 200, over: 650, total: 1_350 });
    // The party's total is the account's balance at the date.
    const [balance] = await h.sql<{ net: string }[]>`
      select sum(l.debit - l.credit) as net from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${h.companyId} and a.code = '130505' and l.party_id = ${partyA} and e.status = 'posted' and e.date <= ${asOf()}::date`;
    expect(Number(balance!.net)).toBe(1_350);
    // By default «Total» leaves out what is not yet due.
    expect((await report("accounting.aging", { kind: "receivable", asOf: asOf() })).rows[0]).toMatchObject({ not_due: 400, total: 950 });

    const payable = await report("accounting.aging", { kind: "payable", asOf: asOf() });
    expect(payable.rows.map((r) => [r.party_name, r.b1, r.total])).toEqual([["Proveedor B S.A.S.", 300, 300]]);

    // Buckets are editable; the due date of an item decides its age; a later date moves items right.
    const custom = await report("accounting.aging", { kind: "receivable", asOf: asOf(), buckets: [10, 20, 30] });
    expect(custom.rows[0]).toMatchObject({ b1: 100, b2: 0, b3: 0, over: 850, not_due: 400 });
    const earlier = await report("accounting.aging", { kind: "receivable", asOf: dateIn(2, 1) });
    expect(earlier.rows[0]).toMatchObject({ total: 0, not_due: 800 });
    await expect(report("accounting.aging", { kind: "receivable", asOf: asOf(), buckets: [30, 20, 90] })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("control reconciliation shows a difference when a receivable has an unapplied credit and zero when tied; suspense row shows the open balance", async () => {
    const tied = await report("accounting.control_reconciliation", { asOf: asOf() });
    const receivable = tied.rows.filter((r) => r.control === "receivable");
    expect(receivable.map((r) => [r.subject, r.ledger, r.subledger, r.difference])).toEqual([["Cliente A S.A.S.", 1_350, 1_350, 0]]);
    expect(tied.rows.filter((r) => r.control === "payable").map((r) => r.difference)).toEqual([0]);
    expect(tied.rows.find((r) => r.control === "suspense")).toMatchObject({ ledger: 0, difference: 0 });
    expect(tied.aggregates.differences).toBe(0);

    // A receipt in advance has no invoice to apply to: the ledger is lower than the open items.
    await post(dateIn(6, 12), [{ code: "111005", debit: 2_000 }, { code: "130505", credit: 2_000, party: partyB }]);
    // And a balance left in the suspense account.
    await post(dateIn(6, 13), [{ code: "238095", debit: 77, party: partyB }, { code: "111005", credit: 77 }]);
    const open = await report("accounting.control_reconciliation", { asOf: asOf() });
    expect(open.rows.filter((r) => r.control === "receivable" && r.subject === "Proveedor B S.A.S.")[0]).toMatchObject({ ledger: -2_000, subledger: 0, difference: -2_000 });
    expect(open.rows.find((r) => r.control === "suspense")).toMatchObject({ subject: expect.stringContaining("238095"), ledger: 77, difference: 77 });
    // The suspense account sits in the payables group, so its unapplied debit is a payable difference too.
    expect(open.aggregates).toMatchObject({ differences: 2, suspense: 77 });
    expect(open.rows.find((r) => r.control === "rounding")).toMatchObject({ ledger: 0 });
  });

  it("manual entries audit lists only non-automatic posted entries with the round flag at 1 000 000 and posted_after_close", async () => {
    await h.sql`delete from accounting.period_close_checks where company_id = ${h.companyId}`.catch(() => undefined);
    const round = await post(dateIn(8, 5), [{ code: "111005", debit: 2_000_000 }, { code: "310505", credit: 2_000_000 }]);
    const odd = await post(dateIn(9, 5), [{ code: "111005", debit: 1_234_567 }, { code: "310505", credit: 1_234_567 }]);
    // An automatic entry never appears.
    const [journal] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'VT'`;
    const [auto] = await h.sql<{ id: string }[]>`insert into accounting.entries (company_id, journal_id, date, description, origin) values (${h.companyId}, ${journal!.id}, ${dateIn(9, 6)}, 'Automático', 'auto') returning id`;
    const [cash] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '111005'`;
    const [capital] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '310505'`;
    await h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit, credit) values (${h.companyId}, ${auto!.id}, 1, ${cash!.id}, 5, 0), (${h.companyId}, ${auto!.id}, 2, ${capital!.id}, 0, 5)`;
    await h.sql`update accounting.entries set status = 'posted', number = 'VT-900', posted_at = now() where id = ${auto!.id}`;
    // September was signed off yesterday (a close whose checks all passed); a failed earlier attempt does not count as the first close.
    const [sep] = await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and number = 9`;
    const rows = ["drafts", "pending_approvals"].map((c) => ({ company_id: h.companyId, period_id: sep!.id, check: c, passed: true, note: "ok", created_at: new Date(Date.now() - 86_400_000) }));
    await h.sql`insert into accounting.period_close_checks ${h.sql(rows)}`;

    const out = await report("accounting.manual_entries_audit", { from: dateIn(8, 1), to: dateIn(9, 30) });
    expect(out.rows.map((r) => r.entry_id)).toEqual([round, odd]);
    expect(out.rows[0]).toMatchObject({ round_amount: true, posted_after_close: false, lines: 2, attachments: 0, amount: 2_000_000, journal_code: "NC" });
    expect(out.rows[1]).toMatchObject({ round_amount: false, posted_after_close: true, amount: 1_234_567 });
    expect(out.rows[0]!.created_by_name).toBeTruthy();
    expect(out.rows[0]!.posted_by_name).toBe(out.rows[0]!.created_by_name);
    expect(out.aggregates).toMatchObject({ amount: 3_234_567, flagged: 2, roundThreshold: 1_000_000 });
    // The threshold is a parameter.
    const wide = await report("accounting.manual_entries_audit", { from: dateIn(8, 1), to: dateIn(9, 30), roundThreshold: 1_234_567 });
    expect(wide.rows.map((r) => r.round_amount)).toEqual([false, true]);
  });

  it("D11: the control reconciliation (shared with the period close checks) gives a restricted user the admin's figures; hidden parties are counted, never named", async () => {
    const [invoiceEntry] = await h.sql<{ id: string }[]>`
      select e.id from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
      where e.company_id = ${h.companyId} and a.code = '130505' and l.debit = 800 limit 1`;
    for (const [entity, recordId] of [["accounting.entry", invoiceEntry!.id], ["core.party", partyB]] as const) {
      await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read) values (${h.companyId}, ${entity}, ${recordId}, ${h.contador.roleId}, true)`;
    }
    try {
      const asAdmin = (await runReport(h.deps, h.admin, "accounting.control_reconciliation", { asOf: asOf() }, state)) as Out;
      const asAux = (await runReport(h.deps, h.auxiliar, "accounting.control_reconciliation", { asOf: asOf() }, state)) as Out;
      expect(asAux.aggregates).toEqual(asAdmin.aggregates);
      const totals = (out: Out, control: string) => out.rows.filter((r) => r.control === control).reduce((acc, r) => ({ ledger: acc.ledger + r.ledger, subledger: acc.subledger + r.subledger }), { ledger: 0, subledger: 0 });
      for (const control of ["receivable", "payable", "suspense", "rounding"]) expect(totals(asAux, control), control).toEqual(totals(asAdmin, control));
      expect(asAux.rows.filter((r) => r.control !== "suspense").length).toBe(asAdmin.rows.filter((r) => r.control !== "suspense").length);
      expect(asAux.rows.some((r) => r.party_id === partyB || r.subject === "Proveedor B S.A.S.")).toBe(false);
      expect(asAdmin.rows.some((r) => r.subject === "Proveedor B S.A.S.")).toBe(true);
    } finally {
      await h.sql`delete from kernel.record_access where company_id = ${h.companyId}`;
    }
  });
});
