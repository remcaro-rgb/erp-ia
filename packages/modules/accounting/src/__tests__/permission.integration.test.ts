import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

let h: AccountingHarness;
beforeAll(async () => {
  h = await accountingHarness({ companies: 2 });
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const accountId = async (code: string) => (await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = ${code}`)[0]!.id;
const visible = (claims: typeof h.admin.claims) =>
  withClaims(h.sql, claims, async (tx) => (await tx<{ code: string }[]>`select code from accounting.v_accounts where code like '5105%' order by code`).map((r) => r.code));
const restrict = async (grants: object[], access: "open" | "restricted" = "restricted", code = "5105") =>
  h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: await accountId(code), access, grants });

describe("account permission", () => {
  it("restricting 5105 for contador (view+post) hides 510506 from auxiliar in v_accounts and from the lookup, and a non-admin cannot update permissions", async () => {
    expect(await visible(h.auxiliar.claims)).toContain("510506");
    await restrict([{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true }]);
    expect(await visible(h.auxiliar.claims)).toEqual([]);
    expect(await visible(h.contador.claims)).toEqual(expect.arrayContaining(["5105", "510506"]));
    expect(await visible(h.admin.claims)).toEqual(expect.arrayContaining(["5105", "510506"]));
    // The lookup (consult) answers not found to the user who cannot see the account.
    await expect(h.run(h.auxiliar, "accounting.account.consult", { id: await accountId("510506") })).rejects.toMatchObject({ code: "not_found" });
    expect(await h.run(h.contador, "accounting.account.consult", { id: await accountId("510506") })).toMatchObject({ code: "510506" });
    // The grant is stored with canView implied by canPost.
    const [grant] = await h.sql`select can_view, can_post, is_active from accounting.account_permissions where company_id = ${h.companyId} and subject_id = ${h.contador.roleId}`;
    expect(grant).toMatchObject({ can_view: true, can_post: true, is_active: true });
    // Even a role granted the process cannot edit permissions unless it is the admin.
    await h.grantAll(h.companyId, h.contador.roleId, ["accounting.account_permission.update", "accounting.account_permission.consult"]);
    await expect(h.runStepUp(h.contador, "accounting.account_permission.update", { accountId: await accountId("5105"), access: "open", grants: [] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.run(h.contador, "accounting.account_permission.consult", { accountId: await accountId("5105") })).rejects.toMatchObject({ code: "forbidden" });
    expect((await h.sql`select access from accounting.accounts where id = ${await accountId("5105")}`)[0]).toMatchObject({ access: "restricted" });
  });

  it("hidden_account_ids (the set the views test once per statement) is exactly the accounts can_view_account refuses, for every kind of caller", async () => {
    await restrict([
      { subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false },
      { subjectKind: "user", subjectId: h.auxiliar.userId, canView: false, canPost: false },
    ]);
    // A restricted account below the restricted one is its own root: it hides from whoever its own grants do not name.
    await restrict([{ subjectKind: "role", subjectId: h.auxiliar.roleId, canView: true, canPost: false }], "restricted", "510506");
    for (const who of [h.admin, h.contador, h.auxiliar]) {
      const [row] = await withClaims(h.sql, who.claims, (tx) => tx<{ refused: string[]; hidden: string[] }[]>`
        select coalesce((select array_agg(id order by id) from accounting.accounts where company_id = ${h.companyId} and not accounting.can_view_account(id)), '{}') as refused,
               coalesce((select array_agg(x order by x) from unnest(accounting.hidden_account_ids()) x), '{}') as hidden`);
      expect(row!.hidden).toEqual(row!.refused);
    }
    // The tree answers the same: a hidden account is no node, whoever asks.
    const nodes = (claims: typeof h.admin.claims) => withClaims(h.sql, claims, (tx) => tx<{ id: string }[]>`select id from accounting.master_tree('account')`).then((r) => r.length);
    const [{ n: all }] = await h.sql<{ n: number }[]>`select count(*)::int as n from accounting.accounts where company_id = ${h.companyId}`;
    expect(await nodes(h.admin.claims)).toBe(all);
    expect(await nodes(h.auxiliar.claims)).toBeLessThan(all);
    await restrict([], "open", "510506");
    await restrict([], "open");
  });

  it("a user grant on 5105 overrides the role grant; removing the restriction opens the subtree again", async () => {
    await restrict([
      { subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false },
      { subjectKind: "user", subjectId: h.contador.userId, canView: false, canPost: false },
      { subjectKind: "user", subjectId: h.auxiliar.userId, canView: true, canPost: false },
    ]);
    expect(await visible(h.contador.claims)).toEqual([]);
    expect(await visible(h.auxiliar.claims)).toEqual(expect.arrayContaining(["5105", "510506"]));
    const id = await accountId("5105");
    const [post] = await withClaims(h.sql, h.auxiliar.claims, (tx) => tx<{ view: boolean; post: boolean }[]>`select accounting.can_view_account(${id}) as view, accounting.can_post_account(${id}) as post`);
    expect(post).toEqual({ view: true, post: false });

    await restrict([], "open");
    expect(await visible(h.contador.claims)).toEqual(expect.arrayContaining(["5105", "510506"]));
    expect(await visible(h.auxiliar.claims)).toEqual(expect.arrayContaining(["5105", "510506"]));
    expect(await h.sql`select 1 from accounting.account_permissions where company_id = ${h.companyId} and account_id = ${await accountId("5105")}`).toHaveLength(0);
  });

  it("the grants of an account are replaced, not merged; consult reports the effective access and where it is inherited from", async () => {
    await restrict([{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false }]);
    await restrict([{ subjectKind: "role", subjectId: h.auxiliar.roleId, canView: true, canPost: true }]);
    const own = await h.run<{ access: string; effective: string; inheritedFrom?: string; grants: { subjectKind: string; subjectId: string; subjectName: string | null; canView: boolean; canPost: boolean }[] }>(
      h.admin, "accounting.account_permission.consult", { accountId: await accountId("5105") });
    expect(own).toMatchObject({ access: "restricted", effective: "restricted" });
    expect(own.inheritedFrom).toBeUndefined();
    expect(own.grants).toEqual([expect.objectContaining({ subjectKind: "role", subjectId: h.auxiliar.roleId, subjectName: "auxiliar", canView: true, canPost: true })]);
    const child = await h.run<{ access: string; effective: string; inheritedFrom?: string }>(h.admin, "accounting.account_permission.consult", { accountId: await accountId("510506") });
    expect(child).toMatchObject({ access: "open", effective: "restricted", inheritedFrom: await accountId("5105") });
    // A subject's own grants (the Cuentas tab of roles and users).
    const forRole = await h.run<{ grants: { accountCode: string; canPost: boolean }[] }>(h.admin, "accounting.account_permission.consult", { subjectKind: "role", subjectId: h.auxiliar.roleId });
    expect(forRole.grants).toEqual([expect.objectContaining({ accountCode: "5105", canPost: true })]);
    await restrict([], "open");
  });

  it("refuses a subject that is not of the company, a repeated subject, and runs only under step-up", async () => {
    const [foreignRole] = await h.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${h.seed.companies[1]!.id} limit 1`;
    await expect(restrict([{ subjectKind: "role", subjectId: foreignRole!.id, canView: true, canPost: false }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(restrict([{ subjectKind: "user", subjectId: newId(), canView: true, canPost: false }])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(restrict([
      { subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false },
      { subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: true },
    ])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(h.run(h.admin, "accounting.account_permission.update", { accountId: await accountId("5105"), access: "restricted", grants: [] })).rejects.toMatchObject({ code: "step_up_required" });
    await expect(h.runStepUp(h.admin, "accounting.account_permission.update", { accountId: newId(), access: "restricted", grants: [] })).rejects.toMatchObject({ code: "invalid_input" });
    expect((await h.sql`select access from accounting.accounts where id = ${await accountId("5105")}`)[0]).toMatchObject({ access: "open" });
  });

  it("every change is audited with the before and after of the access and the grants", async () => {
    await restrict([{ subjectKind: "role", subjectId: h.contador.roleId, canView: true, canPost: false }]);
    const rows = await h.sql<{ diff: { access?: { old: string; new: string }; grants?: { old: unknown[]; new: unknown[] } } }[]>`
      select diff from kernel.audit_log
      where company_id = ${h.companyId} and process_id = 'accounting.account_permission.update' and entity = 'accounting.account' and row_id = ${await accountId("5105")}
      order by occurred_at desc limit 1`;
    expect(rows[0]!.diff.access).toEqual({ old: "open", new: "restricted" });
    expect(rows[0]!.diff.grants!.old).toEqual([]);
    expect(rows[0]!.diff.grants!.new).toHaveLength(1);
    await restrict([], "open");
  });
});
