import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../db/test-db";
import { withClaims, type JwtClaims } from "../db/client";

describe("company isolation", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  const user = (name: string) => seed.users[name]!;
  const company = (index: number) => seed.companies[index]!;

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, {
      companies: 2,
      users: [
        { name: "member", companies: [0], role: "member" },
        { name: "nobody", companies: [] },
      ],
    });
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  /** Runs the access token hook for a user and returns the resulting claims. */
  async function hookClaims(userId: string, appMetadata: { active_company_id?: string } = {}) {
    const [row] = await sql`select kernel.custom_access_token_hook(${sql.json({
      user_id: userId,
      claims: { app_metadata: appMetadata },
    })}) as hook`;
    return row!.hook.claims as Record<string, unknown>;
  }

  it("a member of both companies sees only the active company's roles", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, company(0).id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(r => r.company_id))).toEqual(new Set([company(0).id]));
  });

  it("switching active company changes visible rows", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, company(1).id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.company_id === company(1).id)).toBe(true);
  });

  it("a non-member cannot insert into a company", async () => {
    await expect(withClaims(sql, seed.claimsFor(seed.users.onlyA, company(1).id),
      (tx) => tx`insert into kernel.roles(company_id, name) values (${company(1).id}, 'x')`))
      .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
  });

  it("with company 0 active, a member of both cannot insert into, update or delete company 1's roles", async () => {
    const claims = seed.claimsFor(seed.users.both, company(0).id);
    await expect(withClaims(sql, claims,
      (tx) => tx`insert into kernel.roles(company_id, name) values (${company(1).id}, 'x')`))
      .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });

    const updated = await withClaims(sql, claims,
      (tx) => tx`update kernel.roles set name = 'hacked' where id = ${company(1).adminRoleId} returning id`);
    expect(updated).toHaveLength(0);
    const deleted = await withClaims(sql, claims,
      (tx) => tx`delete from kernel.roles where id = ${company(1).adminRoleId} returning id`);
    expect(deleted).toHaveLength(0);

    const [still] = await sql`select name from kernel.roles where id = ${company(1).adminRoleId}`;
    expect(still?.name).toBe("admin");
  });

  it("tenants, companies and users are scoped to the caller's claims", async () => {
    const claims = seed.claimsFor(seed.users.onlyA, company(0).id);
    const seen = await withClaims(sql, claims, async (tx) => ({
      tenants: await tx`select id from kernel.tenants`,
      companies: await tx`select id from kernel.companies`,
      users: await tx`select id from kernel.users`,
    }));
    expect(seen.tenants.map(r => r.id)).toEqual([seed.tenantId]);
    expect(seen.companies.map(r => r.id)).toEqual([company(0).id]);
    expect(new Set(seen.users.map(r => r.id))).toEqual(new Set([seed.users.both, seed.users.onlyA, user("member")]));
  });

  it("authenticated can only read tenants, companies and users", async () => {
    const claims = seed.claimsFor(seed.users.both, company(0).id);
    await expect(withClaims(sql, claims, (tx) => tx`update kernel.companies set trade_name = 'x'`))
      .rejects.toMatchObject({ code: "42501" });
    await expect(withClaims(sql, claims, (tx) => tx`delete from kernel.users`))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("membership_roles follow the active company and refuse roles of another company", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, company(1).id),
      (tx) => tx`select mr.role_id from kernel.membership_roles mr`);
    expect(rows.map(r => r.role_id)).toEqual([company(1).adminRoleId]);

    await expect(withClaims(sql, seed.claimsFor(seed.users.both, company(1).id),
      (tx) => tx`insert into kernel.membership_roles(membership_id, role_id)
                 select m.id, ${company(0).adminRoleId} from kernel.memberships m where m.user_id = ${seed.users.both}`))
      .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
  });

  describe("only the company admin writes roles and memberships", () => {
    const assignAdminToMember = (tx: Parameters<Parameters<typeof withClaims>[2]>[0]) =>
      tx`insert into kernel.membership_roles(membership_id, role_id)
         select m.id, ${company(0).adminRoleId} from kernel.memberships m
         where m.user_id = ${user("member")} and m.company_id = ${company(0).id}`;

    it("a non-admin member cannot give themselves the admin role", async () => {
      await expect(withClaims(sql, seed.claimsFor(user("member"), company(0).id), assignAdminToMember))
        .rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/row-level security/) });
    });

    it("a non-admin member can read but not create, change or delete roles and memberships", async () => {
      const claims = seed.claimsFor(user("member"), company(0).id);
      const roles = await withClaims(sql, claims, (tx) => tx`select id from kernel.roles`);
      expect(roles.length).toBeGreaterThan(0);
      await expect(withClaims(sql, claims,
        (tx) => tx`insert into kernel.roles(company_id, name) values (${company(0).id}, 'x')`))
        .rejects.toMatchObject({ code: "42501" });
      expect(await withClaims(sql, claims,
        (tx) => tx`update kernel.roles set name = 'x' where id = ${company(0).adminRoleId} returning id`)).toHaveLength(0);
      expect(await withClaims(sql, claims,
        (tx) => tx`delete from kernel.memberships where user_id = ${user("onlyA")} returning id`)).toHaveLength(0);
      const [still] = await sql`select name from kernel.roles where id = ${company(0).adminRoleId}`;
      expect(still?.name).toBe("admin");
    });

    it("the admin can assign a role to a member of the company", async () => {
      const rows = await withClaims(sql, seed.claimsFor(seed.users.onlyA, company(0).id),
        (tx) => tx`insert into kernel.membership_roles(membership_id, role_id)
                   select m.id, ${company(0).memberRoleId} from kernel.memberships m
                   where m.user_id = ${seed.users.onlyA} and m.company_id = ${company(0).id}
                   returning membership_id`);
      expect(rows).toHaveLength(1);
      // Leave the seed as it was for the tests that follow.
      await sql`delete from kernel.membership_roles where membership_id = ${rows[0]!.membership_id} and role_id = ${company(0).memberRoleId}`;
    });
  });

  describe("the access token hook", () => {
    it("adds tenant, company, role and locale claims", async () => {
      const [row] = await sql`select kernel.custom_access_token_hook(${sql.json({ user_id: seed.users.both, claims: {} })}) as hook`;
      const hook = row!.hook;
      expect(hook.claims.company_ids).toHaveLength(2);
      expect(hook.claims.active_company_id).toBeDefined();
    });

    it("returns tenant_id, role_ids and locale matching the seed", async () => {
      const claims = await hookClaims(seed.users.onlyA);
      expect(claims).toMatchObject({
        tenant_id: seed.tenantId,
        company_ids: [company(0).id],
        active_company_id: company(0).id,
        role_ids: [company(0).adminRoleId],
        locale: "es-419",
      });
      const memberClaims = await hookClaims(user("member"));
      expect(memberClaims.role_ids).toEqual([company(0).memberRoleId]);
    });

    it("respects app_metadata.active_company_id when the user is a member of it", async () => {
      const claims = await hookClaims(seed.users.both, { active_company_id: company(1).id });
      expect(claims.active_company_id).toBe(company(1).id);
      expect(claims.role_ids).toEqual([company(1).adminRoleId]);
      expect(claims.company_ids).toEqual([company(0).id, company(1).id]);
    });

    it("falls back to the first membership when app_metadata names a company the user is not in", async () => {
      const claims = await hookClaims(seed.users.onlyA, { active_company_id: company(1).id });
      expect(claims.active_company_id).toBe(company(0).id);
      expect(claims.company_ids).toEqual([company(0).id]);
      const unknown = await hookClaims(seed.users.both, { active_company_id: "00000000-0000-7000-8000-000000000000" });
      expect(unknown.active_company_id).toBe(company(0).id);
    });

    it("gives a user without memberships empty arrays and no error", async () => {
      const claims = await hookClaims(user("nobody"));
      expect(claims.company_ids).toEqual([]);
      expect(claims.role_ids).toEqual([]);
      expect(claims.locale).toBe("es-419");
      expect(claims.active_company_id).toBeUndefined();
      expect(claims.tenant_id).toBeUndefined();
    });

    it("produces claims that the policies accept (hook and RLS agree)", async () => {
      const claims = await hookClaims(seed.users.both, { active_company_id: company(1).id });
      const rows = await withClaims(sql, { sub: seed.users.both, ...claims } as JwtClaims,
        (tx) => tx`select company_id from kernel.roles`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every(r => r.company_id === company(1).id)).toBe(true);
      const canWrite = await withClaims(sql, { sub: seed.users.both, ...claims } as JwtClaims,
        (tx) => tx`insert into kernel.roles(company_id, name) values (${company(1).id}, 'ops') returning id`);
      expect(canWrite).toHaveLength(1);
    });
  });
});
