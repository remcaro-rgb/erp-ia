import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRoleAccount } from "../processes/mapping";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const mappingsOf = async (role: string) =>
  h.sql<{ dimension: string | null; code: string }[]>`
    select m.dimension, a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${h.companyId} and m.role = ${role} order by m.dimension nulls first`;
const resolve = (role: string, dimension?: string) =>
  h.sql.begin(async (tx) => resolveRoleAccount({ tx, companyId: h.companyId } as never, role, dimension));

describe("account role mapping", () => {
  it("maps revenue category:<id> to a subaccount and resolves (role, dimension) before (role, null); an account without movement allowance is refused", async () => {
    const category = newId();
    const target = (await h.sql<{ code: string }[]>`select code from accounting.accounts where company_id = ${h.companyId} and code like '4135__' and allows_movement order by code limit 1`)[0]!.code;
    await h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "revenue", dimension: `category:${category}`, accountId: await accountId(target) }] });
    expect((await mappingsOf("revenue")).map((m) => [m.dimension, m.code])).toEqual([[null, "413595"], [`category:${category}`, target]]);
    expect((await resolve("revenue", `category:${category}`))?.code).toBe(target);
    expect((await resolve("revenue", "category:other"))?.code).toBe("413595");
    expect((await resolve("revenue"))?.code).toBe("413595");
    expect(await resolve("customer_advances", "tax:IVA19")).toMatchObject({ code: "280505" });
    // 4135 is a cuenta (heading), not a posting account.
    await expect(h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "revenue", accountId: await accountId("4135") }] })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await mappingsOf("revenue")).find((m) => m.dimension === null)?.code).toBe("413595");
  });

  it("changes a mapping in place, removes one with null, and lists the unmapped roles", async () => {
    await h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "cash", accountId: await accountId("110510") }] });
    expect((await mappingsOf("cash")).filter((m) => m.dimension === null).map((m) => m.code)).toEqual(["110510"]);
    const removed = await h.runStepUp<{ upserted: number; removed: number }>(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "cash", accountId: null }, { role: "bank", accountId: null }] });
    expect(removed).toEqual({ upserted: 0, removed: 2 });
    const view = await h.run<{ mappings: { role: string; dimension: string | null; accountCode: string }[]; unmapped: string[] }>(h.contador, "accounting.account_role_mapping.consult", {});
    expect(view.unmapped).toEqual(expect.arrayContaining(["cash", "bank"]));
    expect(view.unmapped).not.toContain("receivable");
    expect(view.mappings.find((m) => m.role === "receivable")).toMatchObject({ dimension: null, accountCode: "130505" });
    await h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "cash", accountId: await accountId("110505") }, { role: "bank", accountId: await accountId("111005") }] });
  });

  it("refuses an unknown role, a repeated (role, dimension), an inactive or foreign account, and runs only under step-up", async () => {
    const update = (mappings: object[]) => h.runStepUp(h.admin, "accounting.account_role_mapping.update", { mappings });
    await expect(update([{ role: "not_a_role", accountId: await accountId("110505") }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update([{ role: "cash", accountId: await accountId("110505") }, { role: "cash", accountId: await accountId("110510") }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update([{ role: "cash", accountId: newId() }])).rejects.toMatchObject({ code: "invalid_input" });
    await h.sql`update accounting.accounts set is_active = false where company_id = ${h.companyId} and code = '110515'`;
    await expect(update([{ role: "cash", accountId: await accountId("110515") }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update([{ role: "cash", dimension: "no colon", accountId: await accountId("110505") }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.account_role_mapping.update", { mappings: [{ role: "cash", accountId: await accountId("110505") }] })).rejects.toMatchObject({ code: "step_up_required" });
    await h.sql`update accounting.accounts set is_active = true where company_id = ${h.companyId} and code = '110515'`;
    expect((await mappingsOf("cash")).filter((m) => m.dimension === null).map((m) => m.code)).toEqual(["110505"]);
  });
});

describe("fiscal concept mapping", () => {
  it("concept mapping refuses two concepts for one account in one format and lists unmapped accounts with movement", async () => {
    const update = (mappings: object[]) => h.runStepUp(h.admin, "accounting.fiscal_concept_mapping.update", { mappings });
    const a = await accountId("513595");
    await expect(update([{ format: "1001", concept: "5004", accountId: a }, { format: "1001", concept: "5005", accountId: a }])).rejects.toMatchObject({ code: "invalid_input" });
    // The same account may sit in another format; an unknown format or concept is refused.
    await update([{ format: "1001", concept: "5004", accountId: a }, { format: "1003", concept: "1301", accountId: a }]);
    await expect(update([{ format: "9999", concept: "5004", accountId: a }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(update([{ format: "1001", concept: "0000", accountId: a }])).rejects.toMatchObject({ code: "invalid_input" });
    // Changing the concept of a mapped account in place.
    await update([{ format: "1001", concept: "5005", accountId: a }]);
    expect((await h.sql`select concept from accounting.fiscal_concept_mappings where company_id = ${h.companyId} and format = '1001' and account_id = ${a}`)[0]).toMatchObject({ concept: "5005" });
    // Deactivating keeps the row.
    await update([{ format: "1003", concept: "1301", accountId: a, isActive: false }]);
    expect((await h.sql`select is_active from accounting.fiscal_concept_mappings where company_id = ${h.companyId} and format = '1003' and account_id = ${a}`)[0]).toMatchObject({ is_active: false });
    await expect(h.run(h.admin, "accounting.fiscal_concept_mapping.update", { mappings: [{ format: "1001", concept: "5004", accountId: a }] })).rejects.toMatchObject({ code: "step_up_required" });

    // Movement in the year on an account no concept covers shows as unmapped; a mapped ancestor covers its descendants.
    const year = Number((await h.sql`select extract(year from current_date)::int as y`)[0]!.y);
    const [journal] = await h.sql<{ id: string }[]>`select id from accounting.journals where company_id = ${h.companyId} and code = 'NC'`;
    const post = async (code: string, amount: number) => {
      const [entry] = await h.sql<{ id: string }[]>`insert into accounting.entries (company_id, journal_id, date) values (${h.companyId}, ${journal!.id}, ${`${year}-03-15`}) returning id`;
      await h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, debit) values (${h.companyId}, ${entry!.id}, 1, ${await accountId(code)}, ${amount})`;
      await h.sql`insert into accounting.entry_lines (company_id, entry_id, line_no, account_id, credit) values (${h.companyId}, ${entry!.id}, 2, ${await accountId("110505")}, ${amount})`;
      await h.sql`update accounting.entries set status = 'posted', number = ${`NC-${amount}`} where id = ${entry!.id}`;
    };
    await post("510506", 1000); // under 5105, mapped to 5001 by the seed
    await post("519595", 500); // 5195 is mapped to nothing
    const view = await h.run<{ unmapped: { code: string; movement: number }[]; concepts: { code: string; accounts: { code: string }[] }[] }>(h.contador, "accounting.fiscal_concept_mapping.consult", { format: "1001", year });
    expect(view.unmapped.map((u) => u.code)).toContain("519595");
    expect(view.unmapped.map((u) => u.code)).not.toContain("510506");
    expect(view.unmapped.find((u) => u.code === "519595")).toMatchObject({ movement: 500 });
    expect(view.concepts.find((c) => c.code === "5001")?.accounts.map((x) => x.code)).toContain("5105");
    // The credit-side cash account is not an unmapped payment for a debit format.
    expect(view.unmapped.map((u) => u.code)).not.toContain("110505");
    await expect(h.run(h.contador, "accounting.fiscal_concept_mapping.consult", { format: "9999", year })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("an unmapped account that the caller may not view is not listed", async () => {
    const year = Number((await h.sql`select extract(year from current_date)::int as y`)[0]!.y);
    await h.sql`update accounting.accounts set access = 'restricted' where company_id = ${h.companyId} and code = '5195'`;
    const seen = (claims: typeof h.admin.claims) => h.run<{ unmapped: { code: string }[] }>({ claims, origin: "ui" }, "accounting.fiscal_concept_mapping.consult", { format: "1001", year });
    expect((await seen(h.auxiliar.claims)).unmapped.map((u) => u.code)).not.toContain("519595");
    expect((await seen(h.admin.claims)).unmapped.map((u) => u.code)).toContain("519595");
    await h.sql`update accounting.accounts set access = 'open' where company_id = ${h.companyId} and code = '5195'`;
  });
});
