import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { masterTree, type MasterEntity } from "../masters/tree";
import { accountingHarness, type AccountingHarness, markInvoiceReady } from "./helpers";

// The data of the tree pane (accounting design §8, Task 26): the nodes of the chart and of the analytic dimensions with the
// figure of the selected period, rolled up through the groups, and the restricted accounts left out for who may not view them.

let h: AccountingHarness;
let year: number;
let adm: string;
let otr: string;
let partyId: string;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  const cc = async (code: string, name: string, parent: string | null = null, kind = "leaf") =>
    (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, parent_id, kind) values (${h.companyId}, ${code}, ${name}, ${parent}, ${kind}) returning id`)[0]!.id;
  const sede = await cc("SEDE", "Sede", null, "group");
  adm = await cc("ADM", "Administración", sede);
  otr = await cc("OTR", "Otros", sede);
  partyId = (await h.sql<{ id: string }[]>`
    insert into core.parties (company_id, kind, person_type, document_type, document_number, legal_name, dian_status)
    values (${h.companyId}, '{customer}', '2', '13', '900111222', 'Tiendas D1 S.A.S.', 'errors') returning id`)[0]!.id;
  await markInvoiceReady(h, partyId, "2");
  const entry = async (month: number, day: number, lines: { code: string; debit?: number; credit?: number; cc?: string; party?: boolean }[]) => {
    const { id } = await h.run<{ id: string }>(h.contador, "accounting.entry.create", {
      date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`, description: `Movimiento ${month}/${day}`,
      lines: lines.map((l) => ({ accountCode: l.code, debit: l.debit ?? 0, credit: l.credit ?? 0, ...(l.cc ? { costCenterId: l.cc } : {}), ...(l.party ? { partyId } : {}) })),
    });
    await h.run(h.contador, "accounting.entry.save", { id });
  };
  await entry(1, 10, [{ code: "111005", debit: 10_000 }, { code: "310505", credit: 10_000 }]);
  await entry(2, 5, [{ code: "130505", debit: 1_190, party: true }, { code: "413595", credit: 1_000, cc: adm }, { code: "240801", credit: 190, party: true }]);
  await entry(2, 6, [{ code: "510506", debit: 800, cc: adm }, { code: "111005", credit: 800 }]);
  await entry(3, 8, [{ code: "513505", debit: 200, cc: otr }, { code: "111005", credit: 200 }]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const periodId = async (month: number) =>
  (await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and number = ${month}`)[0]!.id;
const tree = async (caller: { claims: Parameters<typeof withClaims>[1] }, entity: MasterEntity, month: number | null) => {
  const period = month === null ? null : await periodId(month);
  return withClaims(h.sql, caller.claims, (tx) => masterTree(tx, { entity, companyId: h.companyId, periodId: period }));
};
const figure = (items: { code: string; figure: number | null }[], code: string) => items.find((i) => i.code === code)?.figure;

describe("masterTree", () => {
  it("accounts show the balance up to the period, signed by nature, and a group adds up its descendants", async () => {
    const feb = await tree(h.admin, "accounting.account", 2);
    expect(feb.figure).toBe("balance");
    expect(figure(feb.items, "130505")).toBe(1_190);
    expect(figure(feb.items, "13")).toBe(1_190);
    expect(figure(feb.items, "240801")).toBe(190);
    // 10 000 − 800 in cash plus the receivable: the class adds up its whole branch.
    expect(figure(feb.items, "1")).toBe(10_000 - 800 + 1_190);
    const mar = await tree(h.admin, "accounting.account", 3);
    expect(figure(mar.items, "1")).toBe(10_000 - 800 - 200 + 1_190);
    expect(feb.items.find((i) => i.code === "1")).toMatchObject({ parentId: null, restricted: false, level: "class" });
    expect(feb.items.find((i) => i.code === "130505")!.level).toBe("subaccount");
    expect(feb.items.find((i) => i.code === "13")!.parentId).toBe(feb.items.find((i) => i.code === "1")!.id);
  });

  it("without a period the nodes come with no figure", async () => {
    const none = await tree(h.admin, "accounting.account", null);
    expect(none.items.length).toBeGreaterThan(100);
    expect(none.items.every((i) => i.figure === null)).toBe(true);
  });

  it("cost centers show the period's result (income minus expense) and the group adds up its children", async () => {
    const feb = await tree(h.admin, "accounting.cost_center", 2);
    expect(feb.figure).toBe("result");
    expect(figure(feb.items, "ADM")).toBe(1_000 - 800);
    expect(figure(feb.items, "OTR")).toBe(0);
    expect(figure(feb.items, "SEDE")).toBe(200);
    const mar = await tree(h.admin, "accounting.cost_center", 3);
    expect(figure(mar.items, "OTR")).toBe(-200);
    expect(figure(mar.items, "SEDE")).toBe(-200);
  });

  it("the other dimensions show the net movement and list their nodes", async () => {
    const [unit] = await h.sql<{ id: string }[]>`insert into accounting.business_units (company_id, code, name, kind) values (${h.companyId}, 'U1', 'Unidad 1', 'leaf') returning id`;
    const units = await tree(h.admin, "accounting.business_unit", 2);
    expect(units.figure).toBe("movement");
    expect(units.items).toEqual([expect.objectContaining({ id: unit!.id, code: "U1", figure: 0 })]);
  });

  it("a restricted account is marked for who may view it and is not a node at all for who may not", async () => {
    const [account] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '5105'`;
    await h.runStepUp(h.admin, "accounting.account_permission.update", {
      accountId: account!.id, access: "restricted", grants: [{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }],
    });
    try {
      const seen = await tree(h.contador, "accounting.account", 3);
      expect(seen.items.find((i) => i.code === "5105")).toMatchObject({ restricted: true });
      expect(seen.items.find((i) => i.code === "510506")).toMatchObject({ restricted: true });
      expect(figure(seen.items, "510506")).toBe(800);
      const hidden = await tree(h.auxiliar, "accounting.account", 3);
      expect(hidden.items.some((i) => i.code.startsWith("5105"))).toBe(false);
      expect(hidden.items.some((i) => i.code === "513505")).toBe(true);
    } finally {
      await h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: account!.id, access: "open", grants: [] });
    }
  });
});
