import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { accountBalances, nodeFigures } from "../masters/figures";
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
    await h.run(h.contador, "accounting.entry.post", { id });
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
