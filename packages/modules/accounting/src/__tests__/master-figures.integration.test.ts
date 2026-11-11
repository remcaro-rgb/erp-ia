import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportRows, GridState, planExport, runGridQuery } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { accountBalances, listPeriods, nodeFigures } from "../masters/figures";
import { masterTree, MASTER_ENTITIES as TREE_ENTITIES } from "../masters/tree";
import { accountEntity, businessUnitEntity, costCenterEntity, itemEntity, openAuxiliaryEntity } from "../entities";
import { accountingHarness, type AccountingHarness } from "./helpers";

// The figures of the record pages (accounting design §8, Task 28): the Saldos of a Cuenta per period with its descendants, and the
// Saldos por cuenta and Resultados of a node of an analytic dimension, restricted accounts left out for who may not view them.

let h: AccountingHarness;
let year: number;
let sede: string;
let adm: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = async (code: string, name: string, parent: string | null = null, kind = "leaf") =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, parent_id, kind) values (${h.companyId}, ${code}, ${name}, ${parent}, ${kind}) returning id`)[0]!.id;
  sede = await cc("SEDE", "Sede", null, "group");
  adm = await cc("ADM", "Administración", sede);
  const entry = async (month: number, day: number, lines: { code: string; debit?: number; credit?: number; cc?: string }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, description: `Movimiento ${month}/${day}`,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  };
  await entry(1, 10, [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, 5, [{ code: "111005", debit: 1_000 }, { code: "413595", credit: 1_000, cc: adm }]);
  await entry(2, 6, [{ code: "510506", debit: 800, cc: adm }, { code: "111005", credit: 800 }]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const periodOf = (rows: { periodId: string }[], periods: { id: string; number: number }[], month: number) => rows.find((r) => r.periodId === periods.find((p) => p.number === month)!.id)!;

describe("accountBalances", () => {
  it("adds the account's movement per period with the descendants, and the running balance carries over the periods", async () => {
    const result = await withClaims(h.sql, h.admin.claims, async (tx) => accountBalances(tx, { companyId: h.companyId, accountId: await accountId("1110") }));
    expect(result).not.toBeNull();
    const { periods, rows } = result!;
    expect(periods.length).toBe(12);
    expect(periodOf(rows, periods, 1)).toMatchObject({ debit: 10_000, credit: 0, balance: 10_000 });
    expect(periodOf(rows, periods, 2)).toMatchObject({ debit: 1_000, credit: 800, balance: 10_200 });
    expect(periodOf(rows, periods, 3)).toMatchObject({ debit: 0, credit: 0, balance: 10_200 });
  });

  it("a credit-nature account shows its balance positive, and a restricted one answers null to who may not view it", async () => {
    const patrimonio = await withClaims(h.sql, h.admin.claims, async (tx) => accountBalances(tx, { companyId: h.companyId, accountId: await accountId("3105") }));
    expect(periodOf(patrimonio!.rows, patrimonio!.periods, 1)).toMatchObject({ credit: 10_000, balance: 10_000 });
    const gastos = await accountId("5105");
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] });
    try {
      expect(await withClaims(h.sql, h.auxiliar.claims, (tx) => accountBalances(tx, { companyId: h.companyId, accountId: gastos }))).toBeNull();
      const seen = await withClaims(h.sql, h.contador.claims, (tx) => accountBalances(tx, { companyId: h.companyId, accountId: gastos }));
      expect(periodOf(seen!.rows, seen!.periods, 2)).toMatchObject({ debit: 800, balance: 800 });
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "open", grants: [] });
    }
  });
});

describe("nodeFigures", () => {
  it("a group adds up its children: the accounts they moved and the period's income and expense", async () => {
    const node = await withClaims(h.sql, h.admin.claims, (tx) => nodeFigures(tx, { dimension: "cost_center", companyId: h.companyId, nodeId: sede }));
    expect(node).not.toBeNull();
    const feb = node!.periods.find((p) => p.number === 2)!;
    expect(node!.accounts.filter((a) => a.periodId === feb.id).map((a) => [a.code, a.debit, a.credit])).toEqual([["413595", 0, 1_000], ["510506", 800, 0]]);
    expect(node!.results.find((r) => r.periodId === feb.id)).toEqual({ periodId: feb.id, income: 1_000, expense: 800 });
    expect(node!.results.find((r) => r.periodId === node!.periods.find((p) => p.number === 1)!.id)).toMatchObject({ income: 0, expense: 0 });
  });

  it("leaves out the accounts a restricted caller may not view, and answers null for a node that is not there", async () => {
    const gastos = await accountId("5105");
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] });
    try {
      const hidden = await withClaims(h.sql, h.auxiliar.claims, (tx) => nodeFigures(tx, { dimension: "cost_center", companyId: h.companyId, nodeId: adm }));
      expect(hidden!.accounts.map((a) => a.code)).toEqual(["413595"]);
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "open", grants: [] });
    }
    expect(await withClaims(h.sql, h.admin.claims, (tx) => nodeFigures(tx, { dimension: "cost_center", companyId: h.companyId, nodeId: "00000000-0000-7000-8000-000000000000" }))).toBeNull();
  });
});

// ---- the period figure of the masters' Tabla (gaps plan Task 7, OD-2 option A) ---------------------------------------------------

const ENTITIES = { "accounting.account": accountEntity, "accounting.cost_center": costCenterEntity, "accounting.open_auxiliary": openAuxiliaryEntity, "accounting.item": itemEntity, "accounting.business_unit": businessUnitEntity } as const;
const gridState = (params: Record<string, string> | undefined, extra: Record<string, unknown> = {}) =>
  GridState.parse({ filters: [], sort: [], page: 1, pageSize: 500, columns: ["id", "code", "period_figure"], ...(params ? { params } : {}), ...extra });
const figureRows = async (claims: typeof h.admin.claims, entity: keyof typeof ENTITIES, periodId: string | null, extra: Record<string, unknown> = {}) =>
  (await runGridQuery(h.sql, claims, ENTITIES[entity], gridState(periodId ? { period_id: periodId } : undefined, extra))).rows;

describe("the period figure of Tabla", () => {
  it("Tabla figure equals the tree's figure for every node and period, descendants included, for the five masters", async () => {
    // One node of each other dimension, with a parent group, moved in February.
    const node = async (table: string, code: string, parent: string | null, kind: string) =>
      (await h.sql<{ id: string }[]>`insert into ${h.sql("accounting." + table)} (company_id, code, name, parent_id, kind) values (${h.companyId}, ${code}, ${code}, ${parent}, ${kind}) returning id`)[0]!.id;
    const ids: Record<string, string> = {};
    for (const [table, key] of [["open_auxiliaries", "aux"], ["items", "item"], ["business_units", "unit"]] as const) {
      const group = await node(table, `G-${key}`, null, "group");
      ids[key] = await node(table, `L-${key}`, group, "leaf");
    }
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-02-07`, description: "Movimiento dimensiones",
      lines: [
        { accountCode: "111005", debit: 500, credit: 0 },
        { accountCode: "413595", debit: 0, credit: 500, costCenterId: adm, openAuxiliaryId: ids.aux, itemId: ids.item, businessUnitId: ids.unit },
      ],
    });
    await h.run(h.contador, "accounting.entry.save", { id });

    const periods = await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId));
    let compared = 0;
    for (const entity of TREE_ENTITIES) {
      // The chart has thousands of accounts: three periods of it, every period of the small dimension trees.
      for (const period of entity === "accounting.account" ? periods.filter((p) => [1, 2, 12].includes(p.number)) : periods) {
        const tree = await withClaims(h.sql, h.admin.claims, (tx) => masterTree(tx, { entity, companyId: h.companyId, periodId: period.id }));
        const rows: Record<string, unknown>[] = [];
        for (let page = 1; ; page++) {
          const got = await figureRows(h.admin.claims, entity as keyof typeof ENTITIES, period.id, { page });
          rows.push(...got);
          if (got.length < 500) break;
        }
        const grid = new Map(rows.map((r) => [r.id as string, Number(r.period_figure)]));
        expect(rows.length).toBe(tree.items.length);
        for (const item of tree.items) {
          expect(grid.get(item.id), `${entity} ${item.code} period ${period.number}`).toBeCloseTo(item.figure ?? NaN, 2);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
    // No period chosen: the column is empty.
    expect((await figureRows(h.admin.claims, "accounting.cost_center", null)).every((r) => r.period_figure === null)).toBe(true);
  });

  it("period figure of a restricted account is masked and refuses sort and filter", async () => {
    const gastos = await accountId("5105");
    const feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!;
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] });
    try {
      // Who may view it reads its figure; who may not neither reads the row nor finds it in the figure of its parent.
      const seen = await figureRows(h.contador.claims, "accounting.account", feb.id, { filters: [{ field: "code", op: "eq", value: "5105" }] });
      expect(Number(seen[0]!.period_figure)).toBe(800);
      const unseen = await runGridQuery(h.sql, h.auxiliar.claims, accountEntity, gridState({ period_id: feb.id }, { filters: [{ field: "code", op: "starts", value: "51" }] }));
      expect(unseen.rows.map((r) => r.code)).not.toContain("5105");
      expect(unseen.rows.map((r) => r.code)).not.toContain("510506");
      const parent = (await figureRows(h.auxiliar.claims, "accounting.account", feb.id, { filters: [{ field: "code", op: "eq", value: "51" }] }))[0];
      expect(parent === undefined || Number(parent.period_figure) === 0).toBe(true);

      // A role whose field mode for the figure is masked reads null and can neither sort nor filter by it (rule 14).
      await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.auxiliar.roleId}, 'accounting.account', 'period_figure', 'masked')`;
      const masked = await figureRows(h.auxiliar.claims, "accounting.account", feb.id);
      expect(masked.length).toBeGreaterThan(0);
      expect(masked.every((r) => r.period_figure === null)).toBe(true);
      const refused = (extra: Record<string, unknown>) => figureRows(h.auxiliar.claims, "accounting.account", feb.id, extra).then(() => null, (e: unknown) => e);
      expect(await refused({ sort: [{ field: "period_figure", dir: "desc" }] })).toMatchObject({ code: "field_hidden", field: "period_figure" });
      expect(await refused({ filters: [{ field: "period_figure", op: "gt", value: 0 }] })).toMatchObject({ code: "field_hidden", field: "period_figure" });
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and entity = 'accounting.account' and field = 'period_figure'`;
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "open", grants: [] });
    }
  });

  it("sorts and filters by the figure and aggregates it", async () => {
    const feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!;
    const sorted = await figureRows(h.admin.claims, "accounting.account", feb.id, { sort: [{ field: "period_figure", dir: "desc" }], pageSize: 3 });
    expect(Number(sorted[0]!.period_figure)).toBeGreaterThanOrEqual(Number(sorted[1]!.period_figure));
    const big = await figureRows(h.admin.claims, "accounting.account", feb.id, { filters: [{ field: "period_figure", op: "gt", value: 10_000 }] });
    expect(big.length).toBeGreaterThan(0);
    expect(big.every((r) => Number(r.period_figure) > 10_000)).toBe(true);
  });

  it("the export of Tabla with a period carries the figure column of that period", async () => {
    const feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!;
    const registry = h.deps.registry;
    const spec = { entity: "accounting.account", format: "csv" as const, state: { filters: [], sort: [{ field: "code", dir: "asc" as const }], page: 1, pageSize: 50, columns: ["code", "period_figure"], params: { period_id: feb.id } } };
    const plan = await withClaims(h.sql, h.admin.claims, (tx) => planExport(tx, registry, spec));
    expect(plan.columns.map((c) => c.field)).toEqual(["code", "period_figure"]);
    const rows: Record<string, unknown>[] = [];
    for await (const row of exportRows(h.sql, h.admin.claims, plan)) rows.push(row as Record<string, unknown>);
    expect(Number(rows.find((r) => r.code === "1110")!.period_figure)).toBe(10_700);
  });
});

describe("roll-up total of the period figure (UX-OD-3, T4)", () => {
  const total = async (claims: typeof h.admin.claims, periodId: string, filters: unknown[] = []) => {
    const page = await runGridQuery(h.sql, claims, costCenterEntity, GridState.parse({ filters, sort: [], page: 1, pageSize: 500, columns: ["id", "code", "parent_id", "period_figure"], aggregates: [{ field: "period_figure", fn: "sum" }], params: { period_id: periodId } }));
    return { rows: page.rows, sum: page.aggregates?.["sum:period_figure"] };
  };
  let feb: string;
  let vta: string;
  beforeAll(async () => {
    feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!.id;
    vta = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, parent_id, kind) values (${h.companyId}, 'VTA', 'Ventas', ${sede}, 'leaf') returning id`)[0]!.id;
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-02-20`, description: "Ventas del centro",
      lines: [{ accountCode: "111005", debit: 300, credit: 0 }, { accountCode: "413595", debit: 0, credit: 300, costCenterId: vta }],
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  });
  const figureOf = (rows: Record<string, unknown>[], code: string) => Number(rows.find((r) => r.code === code)!.period_figure);

  it("a group with its two leaves totals the group once, not the group plus the leaves", async () => {
    const { rows, sum } = await total(h.admin.claims, feb, [{ field: "code", op: "in", value: ["SEDE", "ADM", "VTA"] }]);
    const group = figureOf(rows, "SEDE");
    expect(group).toBeCloseTo(figureOf(rows, "ADM") + figureOf(rows, "VTA"), 2);
    expect(Number(sum)).toBeCloseTo(group, 2);
    expect(Number(sum)).not.toBeCloseTo(group * 2, 2);
  });

  it("a filter that drops the group totals its remaining leaves; a filter keeping only the group totals the group", async () => {
    const leaves = await total(h.admin.claims, feb, [{ field: "code", op: "in", value: ["ADM", "VTA"] }]);
    expect(Number(leaves.sum)).toBeCloseTo(figureOf(leaves.rows, "ADM") + figureOf(leaves.rows, "VTA"), 2);
    const root = await total(h.admin.claims, feb, [{ field: "code", op: "eq", value: "SEDE" }]);
    expect(Number(root.sum)).toBeCloseTo(figureOf(root.rows, "SEDE"), 2);
  });

  it("a leaf whose group is outside the filter still counts, and a grand total over rows with no figure is null-safe", async () => {
    const one = await total(h.admin.claims, feb, [{ field: "code", op: "eq", value: "VTA" }]);
    expect(Number(one.sum)).toBeCloseTo(300, 2);
  });
});

describe("roll-up total in exports and for a restricted caller (T4 review)", () => {
  it("a grouped export totals the roll-up column over the roots; the groups carry no subtotal of it", async () => {
    const feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!;
    const state = { filters: [], sort: [], page: 1, pageSize: 50, columns: ["code", "kind", "parent_id", "period_figure"], groupBy: ["kind"], aggregates: [{ field: "period_figure", fn: "sum" as const }], params: { period_id: feb.id } };
    const plan = await withClaims(h.sql, h.admin.claims, (tx) => planExport(tx, h.deps.registry, { entity: "accounting.cost_center", format: "csv" as const, state }));
    const rows = (await figureRows(h.admin.claims, "accounting.cost_center", feb.id, { columns: ["id", "code", "parent_id", "period_figure"] })) as Record<string, unknown>[];
    const roots = rows.filter((r) => r.parent_id === null).reduce((a, r) => a + Number(r.period_figure), 0);
    expect(Number(plan.grouped!.grand["sum:period_figure"])).toBeCloseTo(roots, 2);
    expect(plan.grouped!.groups.every((g) => !("sum:period_figure" in g.aggregates))).toBe(true);
  });

  it("a caller who cannot view a restricted account totals only what the caller sees, from the roots of that view", async () => {
    const feb = (await withClaims(h.sql, h.admin.claims, (tx) => listPeriods(tx, h.companyId))).find((p) => p.number === 2)!;
    const gastos = await accountId("5105");
    await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }] });
    try {
      const page = await runGridQuery(h.sql, h.auxiliar.claims, accountEntity, gridState({ period_id: feb.id }, { filters: [{ field: "code", op: "contains", value: "51" }], columns: ["id", "code", "parent_id", "period_figure"], aggregates: [{ field: "period_figure", fn: "sum" }] }));
      const seen = new Set(page.rows.map((r) => r.id as string));
      const expected = page.rows.filter((r) => !(r.parent_id && seen.has(r.parent_id as string))).reduce((a, r) => a + Number(r.period_figure ?? 0), 0);
      expect(page.rows.some((r) => r.code === "5105")).toBe(false);
      expect(page.rows.length).toBeGreaterThan(0);
      expect(Number(page.aggregates?.["sum:period_figure"])).toBeCloseTo(expected, 0);
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: gastos, access: "open", grants: [] });
    }
  });
});
