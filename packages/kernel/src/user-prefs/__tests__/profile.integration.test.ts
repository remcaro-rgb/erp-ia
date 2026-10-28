import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { testDb, seedTenant } from "../../db/test-db";
import { callerProfile } from "../profile";

// What the top bar shows about the caller: name, e-mail, the role names in the active company and the
// companies they belong to, read under their own claims (RLS).

describe("callerProfile", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;

  beforeAll(async () => {
    sql = testDb();
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0], role: "member" }] });
  });
  afterAll(async () => {
    await seed.cleanup();
    await sql.end();
  });

  it("returns the user, the roles of the active company and every company of the claims", async () => {
    const profile = await callerProfile(sql, seed.claimsFor(seed.users.both, seed.companies[1]!.id));
    expect(profile.user).toMatchObject({ id: seed.users.both, name: "User both" });
    expect(profile.user.email).toMatch(/^both-.*@test\.local$/);
    expect(profile.roles).toEqual(["admin"]);
    expect(profile.companies.map((c) => c.id).sort()).toEqual(seed.companies.map((c) => c.id).sort());
    expect(profile.companies[0]!.name).toMatch(/^Company \d .* S\.A\.S\.$/);
  });

  it("carries each company's time zone (the shell formats dates in it)", async () => {
    await sql`update kernel.companies set timezone = 'America/Mexico_City' where id = ${seed.companies[1]!.id}`;
    const profile = await callerProfile(sql, seed.claimsFor(seed.users.both, seed.companies[1]!.id));
    const zoneOf = (id: string) => profile.companies.find((c) => c.id === id)!.timeZone;
    expect(zoneOf(seed.companies[1]!.id)).toBe("America/Mexico_City");
    expect(zoneOf(seed.companies[0]!.id)).toBe("America/Bogota");
  });

  it("names only the roles the caller still holds, even with older claims (final re-review)", async () => {
    const company = seed.companies[0]!;
    // Claims issued while the cashier also held the admin role, which is then taken away.
    const stale = { ...seed.claimsFor(seed.users.cashier!, company.id), role_ids: [company.memberRoleId, company.adminRoleId] };
    await seed.holdRoles(seed.users.cashier!, company.id, [company.adminRoleId]);
    expect((await callerProfile(sql, stale)).roles).toEqual(["admin", "member"]);
    await sql`delete from kernel.membership_roles where role_id = ${company.adminRoleId}
              and membership_id = (select id from kernel.memberships where user_id = ${seed.users.cashier!} and company_id = ${company.id})`;
    expect((await callerProfile(sql, stale)).roles).toEqual(["member"]);
  });

  it("a member of one company sees only that company", async () => {
    const profile = await callerProfile(sql, seed.claimsFor(seed.users.cashier!, seed.companies[0]!.id));
    expect(profile.roles).toEqual(["member"]);
    expect(profile.companies.map((c) => c.id)).toEqual([seed.companies[0]!.id]);
  });
});
