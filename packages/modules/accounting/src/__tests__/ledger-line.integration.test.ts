import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GridState, runGridQuery } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

// Movimientos (accounting design §4.16, §5.14): the `accounting.ledger_line` query entity read through the grid layer, its
// `.list` process and the assistant's `kernel.data.query`. Account security lives in the view, so every level of a grouped
// query, every total and every channel leaves out what the caller may not see.

let h: AccountingHarness;
let year: number;
let adm: string;
let otr: string;
let partyId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ["kernel.data.query"]);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = async (code: string, name: string) =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, ${code}, ${name}, 'leaf') returning id`)[0]!.id;
  adm = await cc("ADM", "Administración");
  otr = await cc("OTR", "Otros");
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Tiendas D1 S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
  const entry = async (month: number, day: number, lines: { code: string; debit?: number; credit?: number; cc?: string; party?: boolean }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(month, day), description: `Movimiento ${month}/${day}`,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}), ...(l.party ? { partyId } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  };
  await entry(1, 10, [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, 5, [{ code: "130505", debit: 1_190, party: true }, { code: "413595", credit: 1_000, cc: adm }, { code: "240801", credit: 190, party: true }]);
  await entry(2, 6, [{ code: "510506", debit: 800, cc: adm }, { code: "111005", credit: 800 }]);
  await entry(3, 7, [{ code: "111005", debit: 500 }, { code: "130505", credit: 500, party: true }]);
  await entry(3, 8, [{ code: "513505", debit: 200, cc: otr }, { code: "111005", credit: 200 }]);
  await entry(3, 9, [{ code: "510506", debit: 300, cc: otr }, { code: "111005", credit: 300 }]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const dateIn = (month: number, day = 15) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const entity = () => h.deps.registry.entity("accounting.ledger_line");
// Rows and groups are read cell by cell: a loose record keeps the assertions readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const base = { filters: [], sort: [], page: 1, pageSize: 500 };
/** The grid route's read: the grid layer as the caller. */
const grid = (caller: typeof h.admin | typeof h.auxiliar, state: object) =>
  runGridQuery(h.sql, caller.claims, entity(), GridState.parse({ ...base, ...state }), { registry: h.deps.registry });
const restrict = async (access: "restricted" | "open") =>
  h.runStepUp(h.admin, "accounting.account_permission.update", {
    accountId: await accountId("5105"), access, grants: access === "restricted" ? [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] : [],
  });
const sum = (rows: Row[], field: string) => rows.reduce((total, r) => total + Number(r[field]), 0);

describe("ledger-line query", () => {
  it("grouped query excludes restricted lines for every level: groupBy [account_code, cost_center_name] as auxiliar has no 5105 group and the grand total equals the visible lines; as admin every group subtotal equals the sum of its lines", async () => {
    const state = { groupBy: ["account_code", "cost_center_name"], aggregates: [{ field: "debit", fn: "sum" }, { field: "credit", fn: "sum" }] };

    const admin = await grid(h.admin, state);
    expect(admin.rows).toHaveLength(13);
    expect(Number(admin.aggregates!["sum:debit"])).toBe(12_990);
    expect(Number(admin.aggregates!["sum:credit"])).toBe(12_990);
    for (const group of admin.groups!) {
      const lines = admin.rows.filter((r) => Object.entries(group.keys).every(([field, value]) => r[field] === value));
      expect(group.count, JSON.stringify(group.keys)).toBe(lines.length);
      expect(Number(group.aggregates["sum:debit"]), JSON.stringify(group.keys)).toBe(sum(lines, "debit"));
      expect(Number(group.aggregates["sum:credit"]), JSON.stringify(group.keys)).toBe(sum(lines, "credit"));
    }
    // Both levels are there: an account and its cost centers.
    expect(admin.groups!.filter((g) => g.level === 1).map((g) => g.keys.account_code)).toContain("510506");
    const expense = admin.groups!.find((g) => g.level === 2 && g.keys.account_code === "510506" && g.keys.cost_center_name === "Otros")!;
    expect(expense).toMatchObject({ count: 1 });
    expect(Number(expense.aggregates["sum:debit"])).toBe(300);

    await restrict("restricted");
    try {
      const aux = await grid(h.auxiliar, state);
      expect(aux.rows.some((r) => String(r.account_code).startsWith("5105"))).toBe(false);
      expect(aux.groups!.some((g) => String(g.keys.account_code).startsWith("5105"))).toBe(false);
      expect(aux.groups!.some((g) => g.level === 2 && String(g.keys.account_code).startsWith("5105"))).toBe(false);
      expect(aux.groups!.some((g) => g.keys.account_code === "513505")).toBe(true);
      expect(aux.rows).toHaveLength(11);
      // The grand total is what the visible lines add up to, not the admin's.
      expect(Number(aux.aggregates!["sum:debit"])).toBe(sum(aux.rows, "debit"));
      expect(Number(aux.aggregates!["sum:debit"])).toBe(12_990 - 800 - 300);
      expect(aux.total).toBe(11);
      // A member holding the grant still sees the account.
      const contador = await grid(h.contador, state);
      expect(contador.groups!.some((g) => g.keys.account_code === "510506")).toBe(true);
      expect(Number(contador.aggregates!["sum:debit"])).toBe(12_990);
    } finally {
      await restrict("open");
    }
  });

  it("a query with three group levels, five sort levels and mixed and/or conditions returns the same rows as the equivalent SQL on v_ledger_lines", async () => {
    const state = {
      // (class 5 and debit > 250) or (account starts 1305) or (party document equals 900111222 and credit > 100)
      filters: [
        { field: "account_class", op: "eq", value: "5" },
        { field: "debit", op: "gt", value: 250, join: "and" },
        { field: "account_code", op: "starts", value: "1305", join: "or" },
        { field: "party_document", op: "eq", value: "900111222", join: "or" },
        { field: "credit", op: "gt", value: 100, join: "and" },
      ],
      groupBy: ["account_class", "journal_code", "cost_center_name"],
      sort: [
        { field: "date", dir: "desc" }, { field: "account_code", dir: "asc" }, { field: "debit", dir: "desc" },
        { field: "credit", dir: "asc" }, { field: "line_no", dir: "desc" },
      ],
      aggregates: [{ field: "debit", fn: "sum" }],
    };
    const result = await grid(h.admin, state);
    const sql = await withClaims(h.sql, h.admin.claims, (tx) =>
      tx<{ entry_id: string; line_no: number; account_class: string; journal_code: string; cost_center_name: string | null; debit: string }[]>`
        select entry_id, line_no, account_class, journal_code, cost_center_name, debit
        from accounting.v_ledger_lines
        where (account_class = '5' and debit > 250) or account_code like '1305%' or (party_document = '900111222' and credit > 100)
        order by account_class asc nulls last, journal_code asc nulls last, cost_center_name asc nulls last,
                 date desc, account_code asc, debit desc, credit asc, line_no desc`);
    expect(sql.length).toBeGreaterThan(0);
    // The same lines in the same order: groups first, then the five sort levels.
    expect(result.rows.map((r) => `${r.entry_id}:${r.line_no}`)).toEqual(sql.map((r) => `${r.entry_id}:${r.line_no}`));
    expect(result.total).toBe(sql.length);
    expect(Number(result.aggregates!["sum:debit"])).toBe(sql.reduce((total, r) => total + Number(r.debit), 0));
    // Three levels of groups, each count the SQL's group-by count.
    expect(new Set(result.groups!.map((g) => g.level))).toEqual(new Set([1, 2, 3]));
    for (const group of result.groups!.filter((g) => g.level === 3)) {
      const same = sql.filter((r) => r.account_class === group.keys.account_class && r.journal_code === group.keys.journal_code && r.cost_center_name === group.keys.cost_center_name);
      expect(group.count).toBe(same.length);
      expect(Number(group.aggregates["sum:debit"])).toBe(same.reduce((total, r) => total + Number(r.debit), 0));
    }
  });

  it("data.query on accounting.ledger_line returns groups and the same totals as the grid route", async () => {
    const state = { groupBy: ["account_class", "cost_center_name"], filters: [{ field: "status", op: "eq", value: "posted" }], aggregates: [{ field: "debit", fn: "sum" }, { field: "credit", fn: "sum" }] };
    const route = await grid(h.admin, state);
    const query = await h.run<{ rows: Row[]; total: number; groups: Row[]; aggregates: Row; entity: string }>(h.admin, "kernel.data.query", {
      entity: "accounting.ledger_line", filters: state.filters, groupBy: state.groupBy, aggregates: state.aggregates, limit: 50,
    });
    expect(query.entity).toBe("accounting.ledger_line");
    expect(query.total).toBe(route.total);
    expect(query.aggregates).toEqual(route.aggregates);
    expect(query.groups).toEqual(route.groups);
    expect(query.groups.length).toBeGreaterThan(0);

    // `accounting.ledger_line.list` is the same read, and it is the process that opens the grid.
    const list = await h.run<{ rows: Row[]; total: number; groups: Row[]; aggregates: Row }>(h.contador, "accounting.ledger_line.list", { state: { ...base, ...state } });
    expect(list.total).toBe(route.total);
    expect(list.aggregates).toEqual(route.aggregates);
    expect(list.groups).toEqual(route.groups);

    // `consult` reads one line by comprobante and line number, through the same view.
    const first = route.rows[0]!;
    const one = await h.run<Row>(h.contador, "accounting.ledger_line.consult", { entryId: first.entry_id, lineNo: first.line_no });
    expect(one).toMatchObject({ entry_id: first.entry_id, line_no: first.line_no, account_code: first.account_code });
    await expect(h.run(h.contador, "accounting.ledger_line.consult", { entryId: first.entry_id, lineNo: 999 })).rejects.toMatchObject({ code: "invalid_input" });

  });
});
