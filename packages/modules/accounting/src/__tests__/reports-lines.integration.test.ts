import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport } from "@erp/kernel";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
let year: number;
let adm: string;
let otr: string;
let group: string;
let partyId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = async (code: string, name: string, kind = "leaf") =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, ${code}, ${name}, ${kind}) returning id`)[0]!.id;
  group = await cc("TOT", "Todo", "group");
  adm = await cc("ADM", "Administración");
  otr = await cc("OTR", "Otros");
  await h.sql`update accounting.cost_centers set parent_id = ${group} where id in (${adm}, ${otr})`;
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Tiendas D1 S.A.S.', 'errors') returning id`)[0]!.id;
  const entry = async (month: number, day: number, lines: { code: string; debit?: number; credit?: number; cc?: string; party?: boolean }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(month, day), description: `Movimiento ${month}/${day}`,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}), ...(l.party ? { partyId } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.post", { id });
  };
  await entry(1, 10, [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, 5, [{ code: "130505", debit: 1_190, party: true }, { code: "413595", credit: 1_000, cc: adm }, { code: "240801", credit: 190, party: true }]);
  await entry(2, 6, [{ code: "510506", debit: 800, cc: adm }, { code: "111005", credit: 800 }]);
  await entry(3, 7, [{ code: "111005", debit: 500 }, { code: "130505", credit: 500, party: true }]);
  await entry(3, 8, [{ code: "513505", debit: 200, cc: otr }, { code: "111005", credit: 200 }]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
// The year is named: other years may be open too (the balance sheet test opens the previous one), and period numbers repeat.
const periodId = async (n: number) =>
  (await h.sql<{ id: string }[]>`select p.id from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id where p.company_id = ${h.companyId} and y.year = ${year} and p.number = ${n}`)[0]!.id;
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// Report rows are read cell by cell in the assertions: a loose record keeps them readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
const report = (caller: typeof h.admin | typeof h.auxiliar, id: string, params: Record<string, unknown>) => runReport(h.deps, caller, id, params, state) as Promise<Out>;
const restrict = async (access: "restricted" | "open") =>
  h.runStepUp(h.admin, "accounting.account_permission.update", {
    accountId: await accountId("5105"), access, grants: access === "restricted" ? [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] : [],
  });
// A getter: the year is known only once the fixtures ran.
const range = { get from() { return dateIn(1, 1); }, get to() { return dateIn(12, 31); } };

describe("line reports", () => {
  it("journal book lists every posted line of the range in date, number, line order; totals equal; restricted lines omitted and counted for auxiliar", async () => {
    const admin = await report(h.admin, "accounting.journal_book", range);
    expect(admin.rows).toHaveLength(11);
    const order = admin.rows.map((r) => `${r.date}|${r.number}|${r.line_no}`);
    expect(order).toEqual([...order].sort((a, b) => {
      const [da, na, la] = a.split("|") as [string, string, string];
      const [db, nb, lb] = b.split("|") as [string, string, string];
      return da.localeCompare(db) || Number(na.split("-")[1]) - Number(nb.split("-")[1]) || Number(la) - Number(lb);
    }));
    expect(admin.aggregates).toMatchObject({ debit: 12_690, credit: 12_690, omitted: 0 });
    expect(admin.rows[0]).toMatchObject({ date: dateIn(1, 10), number: "NC-1", journal_code: "NC", account_code: "111005", debit: 10_000 });
    // Narrowing by date.
    const march = await report(h.admin, "accounting.journal_book", { from: dateIn(3, 1), to: dateIn(3, 31) });
    expect(march.rows).toHaveLength(4);
    // A Fuente with no entries.
    const [other] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'VT'`;
    expect((await report(h.admin, "accounting.journal_book", { ...range, journalId: other!.id })).rows).toHaveLength(0);

    await restrict("restricted");
    try {
      const aux = await report(h.auxiliar, "accounting.journal_book", range);
      expect(aux.rows).toHaveLength(10);
      expect(aux.rows.some((r) => r.account_code === "510506")).toBe(false);
      expect(aux.aggregates).toMatchObject({ omitted: 1, debit: 12_690 - 800, credit: 12_690 });
      expect((await report(h.contador, "accounting.journal_book", range)).aggregates.omitted).toBe(0);
    } finally {
      await restrict("open");
    }
  });

  it("account detail running balance ends at the trial balance closing; a restricted account is refused with Sin acceso", async () => {
    const cash = await report(h.admin, "accounting.account_detail", { accountId: await accountId("111005"), ...range });
    expect(cash.rows[0]).toMatchObject({ row_kind: "opening", balance: 0 });
    expect(cash.rows.slice(1).map((r) => r.balance)).toEqual([10_000, 9_200, 9_700, 9_500]);
    expect(cash.aggregates).toMatchObject({ openingBalance: 0, closingBalance: 9_500, debit: 10_500, credit: 1_000, omitted: 0 });
    const trial = await report(h.admin, "accounting.trial_balance", { from: await periodId(1), to: await periodId(12) });
    const closing = trial.rows.find((r) => r.account_code === "1110")!;
    expect(cash.aggregates.closingBalance).toBe(closing.closing_debit - closing.closing_credit);

    // An opening balance before the range, and a credit-nature account signed by its nature.
    const later = await report(h.admin, "accounting.account_detail", { accountId: await accountId("111005"), from: dateIn(3, 1), to: dateIn(12, 31) });
    expect(later.aggregates).toMatchObject({ openingBalance: 9_200, closingBalance: 9_500 });
    const revenue = await report(h.admin, "accounting.account_detail", { accountId: await accountId("413595"), ...range });
    expect(revenue.aggregates).toMatchObject({ nature: "credit", closingBalance: 1_000 });
    // Filters: the party's receivable.
    const receivable = await report(h.admin, "accounting.account_detail", { accountId: await accountId("130505"), ...range, partyId });
    expect(receivable.aggregates.closingBalance).toBe(690);
    // A parent account takes its descendants.
    const expenses = await report(h.admin, "accounting.account_detail", { accountId: await accountId("51"), ...range });
    expect(expenses.rows.filter((r) => r.row_kind === "line").map((r) => r.account_code)).toEqual(["510506", "513505"]);

    await restrict("restricted");
    try {
      await expect(report(h.auxiliar, "accounting.account_detail", { accountId: await accountId("510506"), ...range })).rejects.toMatchObject({ code: "forbidden", details: ["Sin acceso"] });
      await expect(report(h.auxiliar, "accounting.account_detail", { accountId: await accountId("5105"), ...range })).rejects.toMatchObject({ code: "forbidden", details: ["Sin acceso"] });
      // The group above is readable, without the restricted lines, and says how many were left out.
      const group51 = await report(h.auxiliar, "accounting.account_detail", { accountId: await accountId("51"), ...range });
      expect(group51.rows.filter((r) => r.row_kind === "line").map((r) => r.account_code)).toEqual(["513505"]);
      expect(group51.aggregates.omitted).toBe(1);
    } finally {
      await restrict("open");
    }
  });

  it("account detail: a missing and a restricted account answer the same Sin acceso", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const refusal = { code: "forbidden", details: ["Sin acceso"] };
    await expect(report(h.admin, "accounting.account_detail", { accountId: missing, ...range })).rejects.toMatchObject(refusal);
    await restrict("restricted");
    try {
      await expect(report(h.auxiliar, "accounting.account_detail", { accountId: missing, ...range })).rejects.toMatchObject(refusal);
      await expect(report(h.auxiliar, "accounting.account_detail", { accountId: await accountId("5105"), ...range })).rejects.toMatchObject(refusal);
      const dim = (accountId: string) => report(h.auxiliar, "accounting.dimension_detail", { dimension: "cost_center", nodeId: group, ...range, accountId });
      await expect(dim(missing)).rejects.toMatchObject(refusal);
      await expect(dim(await accountId("5105"))).rejects.toMatchObject(refusal);
    } finally {
      await restrict("open");
    }
  });

  it("party detail follows one party across accounts with a running balance and can be narrowed to some accounts", async () => {
    const all = await report(h.admin, "accounting.party_detail", { partyId, ...range });
    expect(all.rows.filter((r) => r.row_kind === "line").map((r) => [r.account_code, r.balance])).toEqual([["130505", 1_190], ["240801", 1_000], ["130505", 500]]);
    expect(all.aggregates).toMatchObject({ closingBalance: 500, party: "Tiendas D1 S.A.S.", omitted: 0 });
    const receivable = await report(h.admin, "accounting.party_detail", { partyId, accountIds: [await accountId("130505")], ...range });
    expect(receivable.aggregates.closingBalance).toBe(690);
    const later = await report(h.admin, "accounting.party_detail", { partyId, from: dateIn(3, 1), to: dateIn(3, 31) });
    expect(later.aggregates).toMatchObject({ openingBalance: 1_000, closingBalance: 500 });
    await expect(report(h.admin, "accounting.party_detail", { partyId: "00000000-0000-4000-8000-000000000000", ...range })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("dimension detail for a group node equals the sum of its leaves and the ledger for the same filter", async () => {
    const run = (nodeId: string, extra: Record<string, unknown> = {}) => report(h.admin, "accounting.dimension_detail", { dimension: "cost_center", nodeId, ...range, ...extra });
    const whole = await run(group);
    const adm_ = await run(adm);
    const otr_ = await run(otr);
    expect(whole.rows.map((r) => [r.account_code, r.debit, r.credit, r.net])).toEqual([["413595", 0, 1_000, -1_000], ["510506", 800, 0, 800], ["513505", 200, 0, 200]]);
    for (const field of ["debit", "credit", "net"]) expect(whole.aggregates[field]).toBe(adm_.aggregates[field] + otr_.aggregates[field]);
    // The same filter in the trial balance.
    const trial = await report(h.admin, "accounting.trial_balance", { from: await periodId(1), to: await periodId(12), costCenterId: adm });
    expect(trial.aggregates).toMatchObject({ debit: adm_.aggregates.debit, credit: adm_.aggregates.credit });
    // One account of the node.
    expect((await run(group, { accountId: await accountId("51") })).rows.map((r) => r.account_code)).toEqual(["510506", "513505"]);
    await expect(run("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "invalid_input" });

    await restrict("restricted");
    try {
      const aux = await report(h.auxiliar, "accounting.dimension_detail", { dimension: "cost_center", nodeId: group, ...range });
      expect(aux.rows.map((r) => r.account_code)).toEqual(["413595", "513505"]);
      expect(aux.aggregates.omitted).toBe(1);
      await expect(report(h.auxiliar, "accounting.dimension_detail", { dimension: "cost_center", nodeId: group, ...range, accountId: await accountId("5105") })).rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await restrict("open");
    }
  });
});
