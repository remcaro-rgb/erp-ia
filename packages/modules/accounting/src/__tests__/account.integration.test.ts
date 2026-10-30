import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountRow = async (code: string) =>
  (await h.sql`select a.*, p.code as parent_code from accounting.accounts a left join accounting.accounts p on p.id = a.parent_id where a.company_id = ${h.companyId} and a.code = ${code}`)[0];

/** A draft with one line on the account, as the service role. */
async function lineOn(accountId: string, status = "draft") {
  const [journal] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
  const [entry] = await h.sql<{ id: string }[]>`insert into accounting.entries (company_id, journal_id, date) values (${h.companyId}, ${journal!.id}, current_date) returning id`;
  await h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit) values (${h.companyId}, ${entry!.id}, 1, ${accountId}, 10)`;
  if (status !== "draft") await h.sql`update accounting.entries set status = 'voided' where id = ${entry!.id}`;
  return entry!.id;
}

describe("account.create", () => {
  it("13050501 under 130505 is an active auxiliary that inherits the parent's flags; the parent stops taking movements", async () => {
    const { id } = await h.run<{ id: string }>(h.admin, "accounting.account.create", { code: "13050501", name: "Clientes Éxito" });
    const row = (await accountRow("13050501"))!;
    expect(row).toMatchObject({ id, level: "auxiliary", parent_code: "130505", nature: "debit", requires_party: true, allows_movement: true, is_active: true, access: "open" });
    expect((await accountRow("130505"))!.allows_movement).toBe(false);
  });

  it("1306 (above subaccount), a letter code, a duplicate, an orphan code and a child of an account with lines are refused", async () => {
    const create = (input: object) => h.run(h.admin, "accounting.account.create", input);
    await expect(create({ code: "1306", name: "Nueva cuenta" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create({ code: "13A0", name: "x" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create({ code: "13050501", name: "Repetida" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(create({ code: "99999999", name: "Sin madre" })).rejects.toMatchObject({ code: "invalid_input" });
    // An auxiliary needs a subcuenta (6 digits) above it, not a 4-digit cuenta.
    await expect(create({ code: "13990001", name: "Bajo cuenta sin subcuenta" })).rejects.toMatchObject({ code: "invalid_input" });

    const { id } = await create({ code: "13050502", name: "Clientes Olímpica" }) as { id: string };
    await lineOn(id);
    await expect(create({ code: "1305050201", name: "Hijo de cuenta con movimientos" })).rejects.toMatchObject({
      code: "invalid_input",
      details: expect.arrayContaining(["La cuenta padre ya tiene movimientos"]),
    });
  });

  it("explicit flags override the inherited ones; a member without the permission cannot create", async () => {
    await h.run(h.admin, "accounting.account.create", { code: "13050503", name: "Clientes Jumbo", requiresParty: false, requiresCostCenter: true, requiresItem: true, statementSection: "assets_current" });
    expect(await accountRow("13050503")).toMatchObject({ requires_party: false, requires_cost_center: true, requires_item: true, statement_section: "assets_current" });
    await expect(h.run(h.auxiliar, "accounting.account.create", { code: "13050504", name: "No" })).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("account.update and consult", () => {
  it("renames and changes flags but never the code; a strict schema refuses it", async () => {
    const row = (await accountRow("13050501"))!;
    await h.run(h.admin, "accounting.account.update", { id: row.id, name: "Clientes Grupo Éxito", requiresCostCenter: true });
    expect(await accountRow("13050501")).toMatchObject({ name: "Clientes Grupo Éxito", requires_cost_center: true });
    await expect(h.run(h.admin, "accounting.account.update", { id: row.id, code: "13050599" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.account.update", { id: row.id, access: "restricted" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("deactivation is refused while a draft has lines on the account, allowed otherwise, and an inactive account is kept", async () => {
    const withDraft = (await accountRow("13050502"))!;
    await expect(h.run(h.admin, "accounting.account.update", { id: withDraft.id, isActive: false })).rejects.toMatchObject({ code: "invalid_input" });
    const free = (await accountRow("13050503"))!;
    await h.run(h.admin, "accounting.account.update", { id: free.id, isActive: false });
    expect(await accountRow("13050503")).toMatchObject({ is_active: false });
    // Posted/voided history does not block it: void the draft entry's line holder, then deactivate.
    await h.sql`update accounting.entries set status = 'voided' where id in (select entry_id from accounting.entry_lines where account_id = ${withDraft.id})`;
    await h.run(h.admin, "accounting.account.update", { id: withDraft.id, isActive: false });
    expect(await accountRow("13050502")).toMatchObject({ is_active: false });
  });

  it("consult reads the masked view: a restricted account is not found for a user without view", async () => {
    const row = (await accountRow("510506"))!;
    const seen = await h.run<{ id: string; code: string }>(h.auxiliar, "accounting.account.consult", { id: row.id });
    expect(seen).toMatchObject({ id: row.id, code: "510506" });
    await h.sql`update accounting.accounts set access = 'restricted' where id = ${(await accountRow("5105"))!.id}`;
    await expect(h.run(h.auxiliar, "accounting.account.consult", { id: row.id })).rejects.toMatchObject({ code: "not_found" });
    expect((await h.run<{ code: string }>(h.admin, "accounting.account.consult", { id: row.id })).code).toBe("510506");
    await h.sql`update accounting.accounts set access = 'open' where company_id = ${h.companyId} and code = '5105'`;
  });
});
