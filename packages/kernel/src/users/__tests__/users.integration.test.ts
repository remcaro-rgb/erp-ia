import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncRegistry } from "../../admin/sync";
import { withClaims } from "../../db/client";
import { seedTenant, testDb } from "../../db/test-db";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import type { Caller } from "../../process/context";
import { runProcess } from "../../process/run";
import { gridDenial } from "../../query/access";
import { runGridQuery } from "../../query/run";
import { Registry } from "../../registry";
import { describeAuditEntry, readAuditEntry } from "../../audit/detail";

// Migration 0026_kernel_v_users (rule 34) and the `kernel.user` entity (design §22.15, rule 21): kernel.v_users lists the
// members of the caller's active company (never a user of another organization), with each field under the caller's
// field visibility (rule 14) and the mobile, personal data, only for a user of the caller's organization alone and only
// when the caller's roles see it (confidential: masked for every role but the admin by the role defaults).
// `kernel.user.consult` reads one of them; the admin holds it, other roles only when the admin grants it.

describe("kernel users: v_users and kernel.user.consult", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let other: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyA: string;
  let admin: Caller;
  let member: Caller;
  let adminInB: Caller;

  beforeAll(async () => {
    sql = testDb();
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, { companies: 2, entitlements: [], users: [{ name: "member", companies: [0], role: "member" }] });
    other = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "shared", companies: [0] }] });
    companyA = seed.companies[0]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyA), origin: "ui" };
    member = { claims: seed.claimsFor(seed.users.member!, companyA), origin: "ui" };
    adminInB = { claims: seed.claimsFor(seed.users.both, seed.companies[1]!.id), origin: "ui" };
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyA})`;
    await sql`select kernel.seed_company_defaults(${seed.companies[1]!.id})`;
    // Every seeded user has a mobile; the "shared" user of the other organization is also a member of company A (data
    // from before the one-tenant rule).
    for (const id of [seed.users.both, seed.users.onlyA, seed.users.member!, other.users.both, other.users.shared!]) {
      await sql`update kernel.users set mobile_cc = '57', mobile = '3001234567' where id = ${id}`;
    }
    const [shared] = await sql<{ id: string }[]>`insert into kernel.memberships (user_id, company_id) values (${other.users.shared!}, ${companyA}) returning id`;
    await sql`insert into kernel.membership_roles (membership_id, role_id) values (${shared!.id}, ${seed.companies[0]!.memberRoleId})`;
  });
  afterAll(async () => {
    await sql`delete from kernel.membership_roles where membership_id in (select id from kernel.memberships where user_id = ${other.users.shared!})`;
    await sql`delete from kernel.memberships where user_id = ${other.users.shared!}`;
    await seed.cleanup();
    await other.cleanup();
    await sql.end();
  });

  const users = (caller: Caller) => withClaims(sql, caller.claims, (tx) => tx<Record<string, unknown>[]>`select * from kernel.v_users order by email`);

  it("lists the members of the active company with id, full_name, email, locale, mobile, created_at and is_active, never a user of another tenant", async () => {
    const rows = await users(member);
    expect(Object.keys(rows[0]!).sort()).toEqual(["created_at", "email", "full_name", "id", "is_active", "locale", "mobile"]);
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([seed.users.both, seed.users.onlyA, seed.users.member!, other.users.shared!]));
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(other.users.both);
    expect(rows.find((r) => r.id === seed.users.member)?.full_name).toBe("User member");
    // In company B only its members: onlyA and member are not there.
    const inB = (await users(adminInB)).map((r) => r.id);
    expect(inB).toEqual([seed.users.both]);
  });

  it("shows the mobile under the caller's field visibility: the admin sees it, a role with it masked does not", async () => {
    const asAdmin = await users(admin);
    expect(asAdmin.find((r) => r.id === seed.users.member)?.mobile).toBe("3001234567");
    // The role defaults mask the confidential mobile for every role but the admin.
    const asMember = await users(member);
    expect(asMember.find((r) => r.id === seed.users.onlyA)?.mobile).toBeNull();
    expect(asMember.find((r) => r.id === seed.users.onlyA)?.full_name).toBe("User onlyA");
    // Shown to the member once the admin makes it visible to their role; a hidden e-mail reads null.
    await sql`update kernel.field_permissions set mode = 'visible' where company_id = ${companyA} and role_id = ${seed.companies[0]!.memberRoleId} and entity = 'kernel.user' and field = 'mobile'`;
    await sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${companyA}, ${seed.companies[0]!.memberRoleId}, 'kernel.user', 'email', 'hidden')`;
    try {
      const shown = await users(member);
      expect(shown.find((r) => r.id === seed.users.onlyA)?.mobile).toBe("3001234567");
      expect(shown.every((r) => r.email === null)).toBe(true);
    } finally {
      await sql`update kernel.field_permissions set mode = 'masked' where company_id = ${companyA} and role_id = ${seed.companies[0]!.memberRoleId} and entity = 'kernel.user' and field = 'mobile'`;
      await sql`delete from kernel.field_permissions where company_id = ${companyA} and role_id = ${seed.companies[0]!.memberRoleId} and entity = 'kernel.user' and field = 'email'`;
    }
  });

  it("never shows the mobile of a user who also belongs to another organization, even to the admin", async () => {
    const shared = (await users(admin)).find((r) => r.id === other.users.shared);
    expect(shared?.full_name).toBe("User shared");
    expect(shared?.mobile).toBeNull();
  });

  it("is read by nobody without claims and gives anon nothing", async () => {
    const [grant] = await sql<{ anon: boolean; auth: boolean; write: boolean }[]>`
      select has_table_privilege('anon', 'kernel.v_users', 'select') as anon,
             has_table_privilege('authenticated', 'kernel.v_users', 'select') as auth,
             has_table_privilege('authenticated', 'kernel.v_users', 'insert, update, delete') as write`;
    expect(grant).toEqual({ anon: false, auth: true, write: false });
    const none = await withClaims(sql, { ...member.claims, active_company_id: other.companies[0]!.id, company_ids: [other.companies[0]!.id] }, (tx) => tx`select id from kernel.v_users`);
    // A forged active company of another tenant names nobody: the caller is not a member there.
    expect(none).toHaveLength(0);
  });

  it("kernel.user.consult returns one member as the caller sees them; the admin holds it, another role only when granted", async () => {
    const found = (await runProcess({ sql, registry }, admin, "kernel.user.consult", { id: seed.users.member! })) as Record<string, unknown>;
    expect(found).toMatchObject({ id: seed.users.member, full_name: "User member", mobile: "3001234567" });
    await expect(runProcess({ sql, registry }, admin, "kernel.user.consult", { id: other.users.both })).rejects.toMatchObject({ code: "not_found" });
    await expect(runProcess({ sql, registry }, member, "kernel.user.consult", { id: seed.users.onlyA })).rejects.toMatchObject({ code: "forbidden" });
    expect(await gridDenial({ sql, registry }, member.claims, registry.entity("kernel.user"))).toBe("forbidden");
    expect(await gridDenial({ sql, registry }, admin.claims, registry.entity("kernel.user"))).toBeNull();
    // Its grid (the lookups) searches the name and the e-mail over the view.
    const { rows } = await runGridQuery(sql, admin.claims, registry.entity("kernel.user"), { filters: [], sort: [], page: 1, pageSize: 10, search: "onlya" });
    expect(rows.map((r) => r.id)).toEqual([seed.users.onlyA]);
  });

  it("reads nothing for a caller whose membership is inactive, and keeps listing an inactive member to the others", async () => {
    await sql`update kernel.memberships set is_active = false where user_id = ${seed.users.member!} and company_id = ${companyA}`;
    try {
      expect(await users(member)).toHaveLength(0);
    } finally {
      await sql`update kernel.memberships set is_active = true where user_id = ${seed.users.member!} and company_id = ${companyA}`;
    }
    await sql`update kernel.memberships set is_active = false where user_id = ${seed.users.onlyA} and company_id = ${companyA}`;
    try {
      // A deactivated user still names the records and the audit entries that refer to them, marked inactive (0027).
      const listed = await users(admin);
      expect(listed.find((r) => r.id === seed.users.onlyA)?.is_active).toBe(false);
      expect(listed.find((r) => r.id === seed.users.both)?.is_active).toBe(true);
    } finally {
      await sql`update kernel.memberships set is_active = true where user_id = ${seed.users.onlyA} and company_id = ${companyA}`;
    }
  });

  it("lets the audit detail describe a change of a user's profile under the viewer's field visibility (kernel.user is registered)", async () => {
    const [entry] = await sql<{ id: string }[]>`
      insert into kernel.audit_log (company_id, actor_user_id, origin, process_id, entity, row_id, action, diff, chain_id)
      values (${companyA}, ${seed.users.both}, 'ui', 'kernel.admin.user.update', 'kernel.users', ${seed.users.onlyA}, 'update',
              ${sql.json({ full_name: { old: "User onlyA", new: "Ana Pérez" }, mobile: { old: "3001234567", new: "3109876543" }, mobile_cc: { old: "57", new: "57" } })},
              gen_random_uuid())
      returning id`;
    const record = (await withClaims(sql, admin.claims, (tx) => readAuditEntry(tx, entry!.id)))!;
    const asAdmin = await withClaims(sql, admin.claims, (tx) => describeAuditEntry(tx, registry, record));
    expect(asAdmin.described).toBe(true);
    expect(asAdmin.changes.map((c) => c.field).sort()).toEqual(["full_name", "mobile"]);
    expect(asAdmin.changes.find((c) => c.field === "full_name")).toMatchObject({ labelKey: "field.kernel.user.full_name", masked: false, before: "User onlyA", after: "Ana Pérez" });
    expect(asAdmin.changes.find((c) => c.field === "mobile")).toMatchObject({ masked: false, before: "3001234567", after: "3109876543" });
    // A role that sees the mobile masked (the confidential default) gets no value of it.
    const asMember = await withClaims(sql, member.claims, (tx) => describeAuditEntry(tx, registry, record));
    expect(asMember.changes.find((c) => c.field === "mobile")).toMatchObject({ masked: true, before: null, after: null });
    expect(JSON.stringify(asMember)).not.toContain("3109876543");
  });
});

