import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { co } from "@erp/loc-co";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const count = async (table: string) => Number((await h.sql`select count(*)::int as n from ${h.sql(`accounting.${table}`)} where company_id = ${h.companyId}`)[0]!.n);
const thisYear = async () => Number((await h.sql`select extract(year from current_date)::int as y`)[0]!.y);

describe("chart.seed", () => {
  it("chart.seed without step-up is refused, and so is a non-admin with one", async () => {
    await expect(h.run(h.admin, "accounting.chart.seed", {})).rejects.toMatchObject({ code: "step_up_required" });
    await expect(h.runStepUp(h.contador, "accounting.chart.seed", {})).rejects.toMatchObject({ code: "forbidden" });
    expect(await count("accounts")).toBe(0);
  });

  it("chart.seed installs the PUC, mappings, seven journals, concept mappings, settings and the current year, and a second run adds nothing", async () => {
    const pack = co.accounting;
    const first = await h.runStepUp<Record<string, number>>(h.admin, "accounting.chart.seed", {});
    expect(first.accounts).toBe(pack.chartOfAccounts().length + pack.extraAccounts().length);
    expect(first.journals).toBe(7);
    expect(first.mappings).toBe(pack.defaultRoleMappings().length + pack.defaultConceptMappings().length);
    expect(first.rules).toBe(0);
    expect(first.year).toBe(1);
    expect(await count("accounts")).toBe(first.accounts);
    expect(await count("account_role_mappings")).toBe(pack.defaultRoleMappings().length);
    expect(await count("fiscal_concept_mappings")).toBe(pack.defaultConceptMappings().length);
    expect(await count("journals")).toBe(7);
    expect(await count("fiscal_years")).toBe(1);
    expect(await count("periods")).toBe(12);

    const second = await h.runStepUp(h.admin, "accounting.chart.seed", {});
    expect(second).toEqual({ accounts: 0, mappings: 0, journals: 0, rules: 0, year: 0 });
    expect(await count("accounts")).toBe(first.accounts);

    const [s] = await h.sql`select ledger_starts_on, rounding_tolerance, niif_group, manual_journal_id, use_items from accounting.settings where company_id = ${h.companyId}`;
    expect(s).toMatchObject({ rounding_tolerance: "1.0000", niif_group: "2", use_items: false });
    expect(s!.ledger_starts_on).toBeTruthy();
    const [nc] = await h.sql`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
    expect(s!.manual_journal_id).toBe(nc!.id);
  });

  it("the seeded chart is hierarchical: leaf subaccounts allow movement, parents do not; flags come from the pack", async () => {
    const rows = await h.sql<{ code: string; level: string; allows_movement: boolean; requires_party: boolean; requires_cost_center: boolean; parent: string | null; nature: string }[]>`
      select a.code, a.level, a.allows_movement, a.requires_party, a.requires_cost_center, p.code as parent, a.nature
      from accounting.accounts a left join accounting.accounts p on p.id = a.parent_id
      where a.company_id = ${h.companyId} and a.code in ('1', '13', '1305', '130505', '413595', '238095', '530595')`;
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by["130505"]).toMatchObject({ level: "subaccount", allows_movement: true, requires_party: true, parent: "1305", nature: "debit" });
    expect(by["1305"]).toMatchObject({ level: "account", allows_movement: false, parent: "13" });
    expect(by["13"]).toMatchObject({ level: "group", allows_movement: false, parent: "1" });
    expect(by["413595"]).toMatchObject({ allows_movement: true, requires_cost_center: true, nature: "credit" });
    expect(by["238095"]!.allows_movement).toBe(true);
    expect(by["530595"]!.allows_movement).toBe(true);
    // Every default role resolves to an account that takes movements.
    const bad = await h.sql`select m.role from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id where m.company_id = ${h.companyId} and not a.allows_movement`;
    expect(bad).toEqual([]);
  });

  it("a second run never overwrites what the company edited", async () => {
    await h.sql`update accounting.accounts set name = 'Mi caja', requires_item = true where company_id = ${h.companyId} and code = '110505'`;
    await h.sql`delete from accounting.account_role_mappings where company_id = ${h.companyId} and role = 'cash'`;
    const again = await h.runStepUp<Record<string, number>>(h.admin, "accounting.chart.seed", {});
    expect(again).toEqual({ accounts: 0, mappings: 1, journals: 0, rules: 0, year: 0 });
    const [a] = await h.sql`select name, requires_item from accounting.accounts where company_id = ${h.companyId} and code = '110505'`;
    expect(a).toMatchObject({ name: "Mi caja", requires_item: true });
  });
});

describe("fiscal years", () => {
  it("fiscal_year.open next year after this one creates 12 periods; skipping a year is refused; a repeat is refused", async () => {
    const year = await thisYear();
    const opened = await h.run<{ id: string }>(h.admin, "accounting.fiscal_year.open", { year: year + 1 });
    const periods = await h.sql<{ number: number; starts_on: string; ends_on: string }[]>`
      select number, starts_on::text, ends_on::text from accounting.periods where fiscal_year_id = ${opened.id} order by number`;
    expect(periods).toHaveLength(12);
    expect(periods[0]).toMatchObject({ number: 1, starts_on: `${year + 1}-01-01`, ends_on: `${year + 1}-01-31` });
    expect(periods[1]).toMatchObject({ starts_on: `${year + 1}-02-01`, ends_on: `${year + 1}-02-${(year + 1) % 4 === 0 ? 29 : 28}` });
    expect(periods[11]).toMatchObject({ number: 12, ends_on: `${year + 1}-12-31` });
    await expect(h.run(h.admin, "accounting.fiscal_year.open", { year: year + 3 })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.fiscal_year.open", { year: year + 1 })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fiscal_year.consult and period.consult read the masked rows", async () => {
    const [period] = await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} order by starts_on limit 1`;
    const row = await h.run<{ id: string; status: string }>(h.contador, "accounting.period.consult", { id: period!.id });
    expect(row).toMatchObject({ id: period!.id, status: "open" });
    const [fy] = await h.sql<{ id: string }[]>`select id from accounting.fiscal_years where company_id = ${h.companyId} limit 1`;
    expect(await h.run(h.contador, "accounting.fiscal_year.consult", { id: fy!.id })).toMatchObject({ id: fy!.id, status: "open" });
  });
});

describe("journals", () => {
  it("journal.create adds a fuente; a repeated code is refused; update never touches code or consecutivo", async () => {
    const { id } = await h.run<{ id: string }>(h.admin, "accounting.journal.create", { code: "ND", name: "Notas débito", kind: "general" });
    await expect(h.run(h.admin, "accounting.journal.create", { code: "ND", name: "Otra", kind: "general" })).rejects.toMatchObject({ code: "invalid_input" });
    await h.run(h.admin, "accounting.journal.update", { id, name: "Notas de débito", manualEntries: false });
    await expect(h.run(h.admin, "accounting.journal.update", { id, code: "XX" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.journal.update", { id, nextNumber: 5 })).rejects.toMatchObject({ code: "invalid_input" });
    const row = await h.run<{ code: string; name: string; next_number: string; manual_entries: boolean }>(h.contador, "accounting.journal.consult", { id });
    expect(row).toMatchObject({ code: "ND", name: "Notas de débito", manual_entries: false });
    expect(Number(row.next_number)).toBe(1);
  });

  it("the default manual fuente cannot be deactivated", async () => {
    const [nc] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
    await expect(h.run(h.admin, "accounting.journal.update", { id: nc!.id, isActive: false })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
