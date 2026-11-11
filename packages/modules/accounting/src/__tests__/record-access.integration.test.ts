import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runReport, withClaims } from "@erp/kernel";
import { core } from "@erp/module-core";
import { accounting } from "../index";
import { accountBalances, nodeFigures, yearPreview } from "../masters/figures";
import { masterTree } from "../masters/tree";
import { accountingHarness, type AccountingHarness } from "./helpers";

// Record-level access on the ledger (entity types spec 2026-11-02 §9.1, D11; Phase 2A.5 Task 9, Review Focus 2). A comprobante or a
// cuenta narrowed to the contador is hidden from the auxiliar in every table and view (with its lines), while the aggregate reports
// (balances: trial balance, ledger, balance sheet, income statement; the cost center statement) keep its amounts, so accounting
// totals never depend on who looks: a narrowed account at the report's level is folded into the lock line, never named.

let h: AccountingHarness;
let year: number;
let hiddenEntry: string;
let narrowedAccount: string;
let admCc: string;
const dateIn = (y: number, month: number, day = 15) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const periodId = async (n: number) =>
  (await h.sql<{ id: string }[]>`select p.id from accounting.periods p join accounting.fiscal_years y on y.id = p.fiscal_year_id where p.company_id = ${h.companyId} and y.year = ${year} and p.number = ${n}`)[0]!.id;
const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
type Who = AccountingHarness["admin"] | AccountingHarness["auxiliar"];
const report = (caller: Who, id: string, params: Record<string, unknown>) => runReport(h.deps, caller, id, params, state) as Promise<Out>;
const MONEY = ["opening_debit", "opening_credit", "debit", "credit", "closing_debit", "closing_credit"] as const;
/** What `caller` reads of `query` through their claims and RLS. */
const seen = (caller: Who, query: string, params: unknown[]) => withClaims(h.sql, caller.claims, (tx) => tx.unsafe<Row[]>(query, params as never[]));

beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  admCc = cc;
  const entry = async (month: number, description: string, lines: { code: string; debit?: number; credit?: number; cc?: string }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year, month), description,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
    return id;
  };
  await entry(1, "Aporte", [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, "Venta", [{ code: "111005", debit: 3_000 }, { code: "413595", credit: 3_000, cc }]);
  // A comprobante only the contador may see, on accounts everybody sees.
  hiddenEntry = await entry(2, "Bonificación reservada", [{ code: "510506", debit: 700, cc }, { code: "111005", credit: 700 }]);
  // An ordinary comprobante on the account only the contador may see.
  await entry(3, "Honorarios", [{ code: "511025", debit: 400, cc }, { code: "111005", credit: 400 }]);
  narrowedAccount = await accountId("511025");
  // Narrowed by the rules of kernel.record_access (the admin-only process is covered in the kernel suite).
  for (const [entity, recordId] of [["accounting.entry", hiddenEntry], ["accounting.account", narrowedAccount]] as const) {
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_use, can_modify)
                values (${h.companyId}, ${entity}, ${recordId}, ${h.contador.roleId}, true, true, true)`;
  }
}, 180_000);
afterAll(async () => {
  await h.sql`delete from kernel.record_access where company_id = ${h.companyId}`;
  await h.cleanup();
});

describe("record-level access on the ledger (Task 9, D11)", () => {
  it("every table of a core and accounting maestro or documento, and every line table they declare, carries the record read policy", async () => {
    const tables = new Set<string>();
    for (const module of [core, accounting]) {
      for (const entity of module.entities) {
        if (entity.entityType !== "maestro" && entity.entityType !== "documento") continue;
        tables.add(`${entity.schema}.${entity.table}`);
        const lines = entity.typed?.lines;
        if (lines) {
          const line = [...core.entities, ...accounting.entities].find((e) => e.id === lines.entity)!;
          tables.add(`${line.schema}.${line.table}`);
        }
      }
    }
    const policies = await h.sql<{ t: string }[]>`
      select schemaname || '.' || tablename as t from pg_policies where policyname = 'record_access_read' and permissive = 'RESTRICTIVE' and cmd = 'SELECT'`;
    const covered = new Set(policies.map((p) => p.t));
    expect([...tables].filter((t) => !covered.has(t))).toEqual([]);
    expect(tables.has("accounting.entry_lines")).toBe(true);
    expect(tables.has("core.party_contacts")).toBe(true);
  });

  it("the narrowed comprobante and its lines are hidden from the auxiliar, not from the contador or the admin", async () => {
    for (const query of [
      "select id from accounting.entries where id = $1",
      "select id from accounting.v_entries where id = $1",
      "select id from accounting.entry_lines where entry_id = $1",
      "select id from accounting.v_entry_lines where entry_id = $1",
    ]) {
      expect(await seen(h.auxiliar, query, [hiddenEntry]), query).toHaveLength(0);
      expect((await seen(h.contador, query, [hiddenEntry])).length, query).toBeGreaterThan(0);
      expect((await seen(h.admin, query, [hiddenEntry])).length, query).toBeGreaterThan(0);
    }
    expect(await seen(h.auxiliar, "select id from accounting.v_accounts where id = $1", [narrowedAccount])).toHaveLength(0);
    expect(await seen(h.contador, "select id from accounting.v_accounts where id = $1", [narrowedAccount])).toHaveLength(1);
  });

  it("trial balance: the auxiliar's six totals equal the admin's at every level; the narrowed account is folded into the lock line, never named", async () => {
    for (const level of [2, 4, 6]) {
      const params = { from: await periodId(1), to: await periodId(3), level };
      const admin = await report(h.admin, "accounting.trial_balance", params);
      const aux = await report(h.auxiliar, "accounting.trial_balance", params);
      for (const field of MONEY) expect(aux.aggregates[field], `${field} at level ${level}`).toBe(admin.aggregates[field]);
      // The hidden comprobante's 700 is in the totals (cash credit 700 + 400).
      expect(admin.aggregates.debit).toBe(10_000 + 3_000 + 700 + 400);
      if (level === 6) {
        const locked = aux.rows.filter((r) => r.account_code === "🔒");
        expect(locked).toHaveLength(1);
        expect(locked[0]).toMatchObject({ n: 1, debit: 400 });
        expect(aux.rows.some((r) => r.account_code === "511025" || r.account_id === narrowedAccount)).toBe(false);
        expect(admin.rows.some((r) => r.account_code === "511025")).toBe(true);
        expect(aux.aggregates.restricted).toBe(1);
      } else {
        // At a group level the narrowed account is only part of its group's figure.
        expect(aux.rows.some((r) => r.account_code === "🔒")).toBe(false);
      }
    }
  });

  it("libro mayor, balance sheet, income statement and cost center statement: the same totals for the auxiliar and the admin", async () => {
    const ledgerParams = { period: await periodId(2), level: 6 };
    const ledgerAdmin = await report(h.admin, "accounting.ledger", ledgerParams);
    const ledgerAux = await report(h.auxiliar, "accounting.ledger", ledgerParams);
    for (const field of MONEY) expect(ledgerAux.aggregates[field], field).toBe(ledgerAdmin.aggregates[field]);

    const sheet = { asOfPeriod: await periodId(3) };
    const sheetAdmin = await report(h.admin, "accounting.balance_sheet", sheet);
    const sheetAux = await report(h.auxiliar, "accounting.balance_sheet", sheet);
    for (const field of ["assets", "liabilities", "equity", "result", "difference"]) expect(sheetAux.aggregates[field], field).toBe(sheetAdmin.aggregates[field]);

    const range = { from: await periodId(1), to: await periodId(3) };
    const incomeAdmin = await report(h.admin, "accounting.income_statement", { ...range, level: 6 });
    const incomeAux = await report(h.auxiliar, "accounting.income_statement", { ...range, level: 6 });
    const result = (out: Out) => out.rows.find((r) => r.row_kind === "result")!.amount;
    expect(result(incomeAux)).toBe(result(incomeAdmin));
    expect(result(incomeAdmin)).toBe(3_000 - 700 - 400);

    const centersAdmin = await report(h.admin, "accounting.cost_center_statement", range);
    const centersAux = await report(h.auxiliar, "accounting.cost_center_statement", range);
    expect(centersAux.aggregates).toMatchObject({ income: centersAdmin.aggregates.income, expense: centersAdmin.aggregates.expense, net: centersAdmin.aggregates.net });
    expect(centersAdmin.aggregates.expense).toBe(700 + 400);
  });

  it("Revertir a posted comprobante needs the void right on it (the Anular of a Contabilizado one); a hidden one is not found", async () => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year, 3), description: "Para revertir", lines: [{ accountCode: "111005", debit: 50 }, { accountCode: "310505", credit: 50 }],
    });
    await h.run(h.contador, "accounting.entry.save", { id });
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_modify)
                values (${h.companyId}, 'accounting.entry', ${id}, ${h.contador.roleId}, true, true)`;
    const refused = await h.run(h.contador, "accounting.entry.reverse", { id, reason: "Error" }).then(() => null, (e: unknown) => e as { code: string; details: unknown });
    expect(refused).toMatchObject({ code: "record_forbidden", details: { entity: "accounting.entry", recordId: id, right: "void" } });
    const hidden = await h.run(h.auxiliar, "accounting.entry.reverse", { id, reason: "Error" }).then(() => null, (e: unknown) => e as { code: string });
    expect(hidden?.code).toBe("not_found");
    expect((await h.sql`select count(*)::int as n from accounting.entries where reversal_of_id = ${id}`)[0]!.n).toBe(0);
  });

  it("the auxiliar cannot Grabar a comprobante on the narrowed account: refused as an account that does not exist", async () => {
    const attempt = await h.run<{ id: string }>(h.auxiliar, "accounting.entry.create", {
      date: dateIn(year, 3), description: "Intento",
      lines: [{ accountCode: "511025", debit: 1 }, { accountCode: "111005", credit: 1 }],
    }).then(() => null, (e: unknown) => e as { code: string });
    const ghost = await h.run<{ id: string }>(h.auxiliar, "accounting.entry.create", {
      date: dateIn(year, 3), description: "Intento",
      lines: [{ accountCode: "519999", debit: 1 }, { accountCode: "111005", credit: 1 }],
    }).then(() => null, (e: unknown) => e as { code: string });
    expect(attempt?.code).toBe(ghost?.code);
    expect(attempt).not.toBeNull();
  });
});

describe("record-level access on the ledger, fix round 1 (Task 9 review)", () => {
  const as = <T>(caller: Who, fn: (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) => Promise<T>) => withClaims(h.sql, caller.claims, fn);

  it("I6 / M2: the balances come from a grouped aggregate (one row per node), which gives no code, name or id of a node the caller cannot read; the row-level sources are gone", async () => {
    const [gone] = await h.sql<{ amounts: string | null; nodes: string | null }[]>`
      select to_regproc('accounting.ledger_amounts')::text as amounts, to_regproc('accounting.account_nodes')::text as nodes`;
    expect(gone).toEqual({ amounts: null, nodes: null });
    const sums = (caller: Who) => as(caller, (tx) => tx<Row[]>`
      select * from accounting.ledger_sums(${dateIn(year, 1, 1)}::date, ${dateIn(year, 3, 31)}::date, 6, false, null, null, null, null, null, true, true)`);
    const admin = await sums(h.admin);
    const aux = await sums(h.auxiliar);
    // Grouped: one row per account with movement, never one per line (111005 has five lines).
    expect(admin.filter((r) => r.node_code === "111005")).toHaveLength(1);
    expect(aux).toHaveLength(admin.length);
    const total = (rows: Row[], f: string) => rows.reduce((acc, r) => acc + Number(r[f] ?? 0), 0);
    for (const f of ["opening_net", "debit", "credit"]) expect(total(aux, f), f).toBe(total(admin, f));
    const locked = aux.filter((r) => r.restricted);
    expect(locked).toHaveLength(1);
    expect(locked[0]).toMatchObject({ node_id: null, node_code: null, name: null });
    expect(Number(locked[0]!.debit)).toBe(400);
    expect(aux.some((r) => r.node_code === "511025" || r.node_id === narrowedAccount)).toBe(false);
  });

  it("I1: period_figure (the Tabla) and the tree pane give the auxiliar the admin's figures, hidden comprobantes and accounts included", async () => {
    const p2 = await periodId(2);
    const p3 = await periodId(3);
    const group = await accountId("51");
    const figure = (caller: Who, kind: string, node: string, period: string) =>
      as(caller, async (tx) => (await tx<{ f: string | null }[]>`select accounting.period_figure(${kind}, ${node}::uuid, ${period}::uuid)::text as f`)[0]!.f);
    expect(await figure(h.admin, "account", group, p3)).toBe("1100.00");
    expect(await figure(h.auxiliar, "account", group, p3)).toBe("1100.00");
    expect(await figure(h.admin, "cost_center", admCc, p2)).toBe("2300.00");
    expect(await figure(h.auxiliar, "cost_center", admCc, p2)).toBe("2300.00");
    // A node the caller cannot read has no figure.
    expect(await figure(h.auxiliar, "account", narrowedAccount, p3)).toBeNull();

    const tree = (caller: Who, entity: "accounting.account" | "accounting.cost_center", period: string) =>
      as(caller, (tx) => masterTree(tx, { entity, companyId: h.companyId, periodId: period }));
    const accountsAdmin = await tree(h.admin, "accounting.account", p3);
    const accountsAux = await tree(h.auxiliar, "accounting.account", p3);
    const fig = (t: Awaited<ReturnType<typeof masterTree>>, code: string) => t.items.find((i) => i.code === code)?.figure;
    for (const code of ["5", "51", "5105", "5110", "1", "11"]) expect(fig(accountsAux, code), code).toBe(fig(accountsAdmin, code));
    expect(fig(accountsAdmin, "51")).toBe(1100);
    expect(accountsAux.items.some((i) => i.id === narrowedAccount)).toBe(false);
    const centersAdmin = await tree(h.admin, "accounting.cost_center", p2);
    const centersAux = await tree(h.auxiliar, "accounting.cost_center", p2);
    expect(fig(centersAux, "ADM")).toBe(fig(centersAdmin, "ADM"));

    // The record pages: Saldos of a cuenta and the figures of a centro de costo.
    const balancesAdmin = await as(h.admin, (tx) => accountBalances(tx, { companyId: h.companyId, accountId: group }));
    const balancesAux = await as(h.auxiliar, (tx) => accountBalances(tx, { companyId: h.companyId, accountId: group }));
    expect(balancesAux!.rows).toEqual(balancesAdmin!.rows);
    const nodeAdmin = await as(h.admin, (tx) => nodeFigures(tx, { dimension: "cost_center", companyId: h.companyId, nodeId: admCc }));
    const nodeAux = await as(h.auxiliar, (tx) => nodeFigures(tx, { dimension: "cost_center", companyId: h.companyId, nodeId: admCc }));
    expect(nodeAux!.results).toEqual(nodeAdmin!.results);
    const sum = (rows: { debit: number; credit: number }[]) => rows.reduce((acc, r) => acc + r.debit - r.credit, 0);
    expect(sum(nodeAux!.accounts)).toBe(sum(nodeAdmin!.accounts));
    expect(nodeAux!.accounts.some((r) => r.code === "511025" || r.accountId === narrowedAccount)).toBe(false);
    // The year close preview adds up the same result.
    const fiscalYear = (await h.sql<{ id: string }[]>`select id from accounting.fiscal_years where company_id = ${h.companyId} and year = ${year}`)[0]!.id;
    const previewAdmin = await as(h.admin, (tx) => yearPreview(tx, { companyId: h.companyId, fiscalYearId: fiscalYear }));
    const previewAux = await as(h.auxiliar, (tx) => yearPreview(tx, { companyId: h.companyId, fiscalYearId: fiscalYear }));
    expect({ income: previewAux!.income, expense: previewAux!.expense }).toEqual({ income: previewAdmin!.income, expense: previewAdmin!.expense });
  });

  it("I7: the cost center statement totals the whole tree: a hidden group with a visible child, a visible group with a hidden child; a hidden nodeId does not exist", async () => {
    const center = async (code: string, kind: "group" | "leaf", parent: string | null) =>
      (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind, parent_id) values (${h.companyId}, ${code}, ${`Centro ${code}`}, ${kind}, ${parent}) returning id`)[0]!.id;
    const hiddenGroup = await center("GRP", "group", null);
    const visibleChild = await center("GRP1", "leaf", hiddenGroup);
    const visibleGroup = await center("VTA", "group", null);
    const hiddenChild = await center("VTA1", "leaf", visibleGroup);
    for (const id of [hiddenGroup, hiddenChild]) {
      await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read, can_use, can_modify)
                  values (${h.companyId}, 'accounting.cost_center', ${id}, ${h.contador.roleId}, true, true, true)`;
    }
    for (const [cc, amount] of [[visibleChild, 250], [hiddenChild, 120]] as const) {
      const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
        date: dateIn(year, 3), description: "Gasto por centro", lines: [{ accountCode: "510506", debit: amount, costCenterId: cc }, { accountCode: "111005", credit: amount }],
      });
      await h.run(h.contador, "accounting.entry.save", { id });
    }
    const range = { from: await periodId(1), to: await periodId(3) };
    const admin = await report(h.admin, "accounting.cost_center_statement", range);
    const aux = await report(h.auxiliar, "accounting.cost_center_statement", range);
    expect(aux.aggregates).toMatchObject({ income: admin.aggregates.income, expense: admin.aggregates.expense, net: admin.aggregates.net });
    expect(admin.aggregates.expense).toBe(700 + 400 + 250 + 120);
    const names = (out: Out) => out.rows.map((r) => r.cost_center_code);
    expect(names(aux)).not.toContain("GRP");
    expect(names(aux)).not.toContain("VTA1");
    expect(aux.rows.find((r) => r.cost_center_code === "VTA")).toMatchObject({ expense: 120 });
    expect(aux.rows.find((r) => r.cost_center_code === "GRP1")).toMatchObject({ expense: 250 });
    expect(aux.rows.some((r) => r.cost_center_id === hiddenGroup || r.cost_center_id === hiddenChild)).toBe(false);

    // nodeId: a visible group adds up its hidden child; a hidden node is refused exactly as one that does not exist.
    const nodeAdmin = await report(h.admin, "accounting.cost_center_statement", { ...range, nodeId: visibleGroup });
    const nodeAux = await report(h.auxiliar, "accounting.cost_center_statement", { ...range, nodeId: visibleGroup });
    expect(nodeAux.aggregates).toMatchObject({ income: nodeAdmin.aggregates.income, expense: nodeAdmin.aggregates.expense, net: nodeAdmin.aggregates.net });
    expect(nodeAux.aggregates.expense).toBe(120);
    const refused = (nodeId: string) => report(h.auxiliar, "accounting.cost_center_statement", { ...range, nodeId }).then(() => null, (e: unknown) => e as { code: string; details: unknown });
    const hidden = await refused(hiddenGroup);
    const missing = await refused("01900000-0000-7000-8000-000000000000");
    expect(hidden).toMatchObject({ code: "invalid_input" });
    expect(hidden?.details).toEqual(missing?.details);
  });

  it("I2: the opening's references need usability only, not the caller's use right; a manual Grabar on the same account keeps it", async () => {
    const [free] = await h.sql<{ id: string; code: string }[]>`
      select id, code from accounting.accounts where company_id = ${h.companyId} and allows_movement and not requires_party and not requires_cost_center
        and not requires_open_auxiliary and not requires_item and not requires_business_unit and code like '11%' and code <> '111005' order by code limit 1`;
    await h.sql`insert into kernel.record_access (company_id, entity, record_id, grantee_role_id, can_read)
                values (${h.companyId}, 'accounting.account', ${free!.id}, ${h.contador.roleId}, true)`;
    for (const process of ["accounting.opening.create", "accounting.opening.post"]) {
      await h.sql`insert into kernel.process_permissions (company_id, role_id, process_id) values (${h.companyId}, ${h.contador.roleId}, ${process}) on conflict do nothing`;
    }
    const manual = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: dateIn(year, 3), description: "Manual", lines: [{ accountCode: free!.code, debit: 10 }, { accountCode: "310505", credit: 10 }],
    });
    const refused = await h.run(h.contador, "accounting.entry.save", { id: manual.id }).then(() => null, (e: unknown) => e as { code: string; details: unknown });
    expect(refused).toMatchObject({ code: "record_forbidden", details: { entity: "accounting.account", recordId: free!.id, right: "use" } });

    const { id } = await h.run<{ id: string }>(h.contador, "accounting.opening.create", { lines: [{ accountCode: free!.code, debit: 10 }, { accountCode: "310505", credit: 10 }] });
    await expect(h.runStepUp(h.contador, "accounting.opening.post", { id })).resolves.toMatchObject({ number: expect.any(String) });
  });

  it("tree pane: with parent_id masked or hidden for the caller, every node shows at the root (rule 14); the figures still add up the whole tree", async () => {
    const p3 = await periodId(3);
    const tree = (caller: Who) => as(caller, (tx) => masterTree(tx, { entity: "accounting.account", companyId: h.companyId, periodId: p3 }));
    const before = await tree(h.auxiliar);
    const adminTree = await tree(h.admin);
    const adminFigure = adminTree.items.find((i) => i.code === "51")!.figure;
    expect(before.items.find((i) => i.code === "5105")!.parentId).not.toBeNull();
    for (const mode of ["masked", "hidden"]) {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${h.auxiliar.roleId} and entity = 'accounting.account' and field = 'parent_id'`;
      await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.auxiliar.roleId}, 'accounting.account', 'parent_id', ${mode})`;
      const masked = await tree(h.auxiliar);
      expect(masked.items.every((i) => i.parentId === null), mode).toBe(true);
      expect(masked.items.find((i) => i.code === "51")!.figure, mode).toBe(adminFigure);
    }
    await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${h.auxiliar.roleId} and entity = 'accounting.account' and field = 'parent_id'`;
  });
});
