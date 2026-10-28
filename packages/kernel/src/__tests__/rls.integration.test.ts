import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../db/test-db";
import { withClaims } from "../db/client";

describe("company isolation", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2 });
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("a member of both companies sees only the active company's roles", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[0]!.id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map(r => r.company_id))).toEqual(new Set([seed.companies[0]!.id]));
  });

  it("switching active company changes visible rows", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[1]!.id),
      (tx) => tx`select company_id from kernel.roles`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.company_id === seed.companies[1]!.id)).toBe(true);
  });

  it("a non-member cannot insert into a company", async () => {
    await expect(withClaims(sql, seed.claimsFor(seed.users.onlyA, seed.companies[1]!.id),
      (tx) => tx`insert into kernel.roles(company_id, name) values (${seed.companies[1]!.id}, 'x')`))
      .rejects.toThrow(/row-level security/);
  });

  it("the access token hook adds company and role claims", async () => {
    const [row] = await sql`select kernel.custom_access_token_hook(${sql.json({ user_id: seed.users.both, claims: {} })}) as hook`;
    const hook = row!.hook;
    expect(hook.claims.company_ids).toHaveLength(2);
    expect(hook.claims.active_company_id).toBeDefined();
  });

  // Beyond the brief: the other tenancy tables are also under RLS (rule 12).
  it("tenants, companies and users are scoped to the caller's claims", async () => {
    const claims = seed.claimsFor(seed.users.onlyA, seed.companies[0]!.id);
    const seen = await withClaims(sql, claims, async (tx) => ({
      tenants: await tx`select id from kernel.tenants`,
      companies: await tx`select id from kernel.companies`,
      users: await tx`select id from kernel.users`,
    }));
    expect(seen.tenants.map(r => r.id)).toEqual([seed.tenantId]);
    expect(seen.companies.map(r => r.id)).toEqual([seed.companies[0]!.id]);
    expect(new Set(seen.users.map(r => r.id))).toEqual(new Set([seed.users.both, seed.users.onlyA]));
  });

  it("membership_roles follow the active company and refuse roles of another company", async () => {
    const rows = await withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[1]!.id),
      (tx) => tx`select mr.role_id from kernel.membership_roles mr`);
    expect(rows.map(r => r.role_id)).toEqual([seed.companies[1]!.adminRoleId]);

    await expect(withClaims(sql, seed.claimsFor(seed.users.both, seed.companies[1]!.id),
      (tx) => tx`insert into kernel.membership_roles(membership_id, role_id)
                 select m.id, ${seed.companies[0]!.adminRoleId} from kernel.memberships m where m.user_id = ${seed.users.both}`))
      .rejects.toThrow(/row-level security/);
  });
});
