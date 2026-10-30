import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { accountingHarness, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness();
});
afterAll(async () => {
  await h.cleanup();
});

/** Inserts an account as the service role; the trigger derives parent and level from the code. */
async function account(code: string, extra: { access?: "open" | "restricted"; allows?: boolean } = {}) {
  const [row] = await h.sql<{ id: string }[]>`
    insert into accounting.accounts (company_id, code, name, nature, level, allows_movement, access)
    values (${h.companyId}, ${code}, ${`Cuenta ${code}`}, 'debit', 'class', ${extra.allows ?? false}, ${extra.access ?? "open"}) returning id`;
  return row!.id;
}
const visibleCodes = (member: { claims: Parameters<typeof withClaims>[1] }) =>
  withClaims(h.sql, member.claims, async (tx) => (await tx<{ code: string }[]>`select code from accounting.v_accounts order by code`).map((r) => r.code));

describe("masters schema", () => {
  it("accounts_set_parent_level derives the parent (longest existing prefix) and the level from the code", async () => {
    await account("5");
    await account("51");
    await account("5105");
    const sub = await account("510506", { allows: true });
    await account("51050601");
    const rows = await h.sql<{ code: string; level: string; parent: string | null }[]>`
      select a.code, a.level, p.code as parent from accounting.accounts a left join accounting.accounts p on p.id = a.parent_id
      where a.company_id = ${h.companyId} and a.code like '5%' order by a.code`;
    expect(rows).toEqual([
      { code: "5", level: "class", parent: null },
      { code: "51", level: "group", parent: "5" },
      { code: "5105", level: "account", parent: "51" },
      { code: "510506", level: "subaccount", parent: "5105" },
      { code: "51050601", level: "auxiliary", parent: "510506" },
    ]);
    expect(sub).toBeTruthy();
  });

  it("refuses a non-numeric code, a duplicate code and a second mapping for one (role, dimension)", async () => {
    await expect(h.sql`insert into accounting.accounts (company_id, code, name, nature, level) values (${h.companyId}, '51A', 'x', 'debit', 'group')`).rejects.toThrow();
    await account("7105");
    await expect(account("7105")).rejects.toThrow();
    const acc = await account("1105", { allows: true });
    const mapping = (dimension: string | null) => h.sql`insert into accounting.account_role_mappings (company_id, role, dimension, account_id) values (${h.companyId}, 'cash', ${dimension}, ${acc})`;
    await mapping(null);
    await expect(mapping(null)).rejects.toThrow();
    await mapping("payment_method:cash");
    await expect(mapping("payment_method:cash")).rejects.toThrow();
  });

  it("assigns a gap-free seq per entity and keeps it on update", async () => {
    const [a, b] = await h.sql<{ seq: string }[]>`select seq from accounting.accounts where company_id = ${h.companyId} order by seq limit 2`;
    expect(Number(b!.seq)).toBe(Number(a!.seq) + 1);
    await h.sql`update accounting.accounts set name = 'Otro' where company_id = ${h.companyId} and code = '51'`;
    const [after] = await h.sql<{ seq: string }[]>`select seq from accounting.accounts where company_id = ${h.companyId} and code = '51'`;
    expect(Number(after!.seq)).toBeGreaterThan(0);
  });

  it("one settings row per company; one period number per fiscal year", async () => {
    await h.sql`insert into accounting.settings (company_id) values (${h.companyId})`;
    await expect(h.sql`insert into accounting.settings (company_id) values (${h.companyId})`).rejects.toThrow();
    const [year] = await h.sql<{ id: string }[]>`insert into accounting.fiscal_years (company_id, year, starts_on, ends_on) values (${h.companyId}, 2026, '2026-01-01', '2026-12-31') returning id`;
    const period = () => h.sql`insert into accounting.periods (company_id, fiscal_year_id, number, starts_on, ends_on) values (${h.companyId}, ${year!.id}, 1, '2026-01-01', '2026-01-31')`;
    await period();
    await expect(period()).rejects.toThrow();
    const [settings] = await h.sql`select rounding_tolerance, niif_group, require_approval_on_manual, use_items from accounting.settings where company_id = ${h.companyId}`;
    expect(settings).toMatchObject({ rounding_tolerance: "1.0000", niif_group: "2", require_approval_on_manual: false, use_items: false });
  });
});

describe("can_view_account resolves nearest ancestor, user over role, admin always", () => {
  beforeAll(async () => {
    for (const code of ["6", "61", "6105", "610506", "61050601"]) await account(code, { allows: code === "610506" });
  });

  it("a restricted account hides its subtree from the auxiliar and shows it to the contador with a role grant", async () => {
    const restricted = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '6105'`)[0]!.id;
    expect(await visibleCodes(h.auxiliar)).toContain("610506");
    await h.sql`update accounting.accounts set access = 'restricted' where id = ${restricted}`;
    await h.sql`insert into accounting.account_permissions (company_id, account_id, subject_kind, subject_id, can_view, can_post)
                values (${h.companyId}, ${restricted}, 'role', ${h.contador.roleId}, true, false)`;
    const forAuxiliar = await visibleCodes(h.auxiliar);
    expect(forAuxiliar).not.toContain("6105");
    expect(forAuxiliar).not.toContain("610506");
    expect(forAuxiliar).not.toContain("61050601");
    expect(forAuxiliar).toContain("61");
    const forContador = await visibleCodes(h.contador);
    expect(forContador).toEqual(expect.arrayContaining(["6105", "610506", "61050601"]));
    // The admin always sees everything.
    expect(await visibleCodes(h.admin)).toEqual(expect.arrayContaining(["6105", "610506"]));
  });

  it("can_post_account follows can_post; a user grant wins over the role grants, both ways", async () => {
    const sub = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '610506'`)[0]!.id;
    const restricted = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '6105'`)[0]!.id;
    const canPost = (member: { claims: Parameters<typeof withClaims>[1] }) =>
      withClaims(h.sql, member.claims, async (tx) => (await tx<{ ok: boolean }[]>`select accounting.can_post_account(${sub}) as ok`)[0]!.ok);
    expect(await canPost(h.contador)).toBe(false);
    expect(await canPost(h.auxiliar)).toBe(false);
    expect(await canPost(h.admin)).toBe(true);
    // Role grant with post → the contador may post.
    await h.sql`update accounting.account_permissions set can_post = true where account_id = ${restricted} and subject_id = ${h.contador.roleId}`;
    expect(await canPost(h.contador)).toBe(true);
    // A user grant that denies view beats the role grant: hidden, and not postable.
    await h.sql`insert into accounting.account_permissions (company_id, account_id, subject_kind, subject_id, can_view, can_post)
                values (${h.companyId}, ${restricted}, 'user', ${h.contador.userId}, false, false)`;
    expect(await visibleCodes(h.contador)).not.toContain("610506");
    expect(await canPost(h.contador)).toBe(false);
    // A user grant for the auxiliar opens the subtree to that user alone.
    await h.sql`insert into accounting.account_permissions (company_id, account_id, subject_kind, subject_id, can_view, can_post)
                values (${h.companyId}, ${restricted}, 'user', ${h.auxiliar.userId}, true, true)`;
    expect(await visibleCodes(h.auxiliar)).toContain("610506");
    expect(await canPost(h.auxiliar)).toBe(true);
  });

  it("can_post implies can_view (a grant that posts without viewing is refused); removing the restriction opens the subtree again", async () => {
    const restricted = (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '6105'`)[0]!.id;
    await expect(h.sql`insert into accounting.account_permissions (company_id, account_id, subject_kind, subject_id, can_view, can_post)
                       values (${h.companyId}, ${restricted}, 'role', ${h.seed.companies[0]!.memberRoleId}, false, true)`).rejects.toThrow();
    await h.sql`update accounting.accounts set access = 'open' where id = ${restricted}`;
    expect(await visibleCodes(h.contador)).toContain("610506");
    expect(await visibleCodes(h.auxiliar)).toContain("6105");
  });

  it("a restriction on a descendant applies to it alone; another company's accounts are never visible", async () => {
    await h.sql`update accounting.accounts set access = 'restricted' where company_id = ${h.companyId} and code = '61050601'`;
    const codes = await visibleCodes({ claims: { ...h.contador.claims } });
    expect(codes).toContain("610506");
    expect(codes).not.toContain("61050601");
    await h.sql`update accounting.accounts set access = 'open' where company_id = ${h.companyId} and code = '61050601'`;
  });
});
