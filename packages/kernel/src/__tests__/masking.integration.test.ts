import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { testDb, seedTenant, ensureRoleProbe } from "../db/test-db";
import { withClaims } from "../db/client";

describe("field-level masking", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let extraRoleId: string;
  const company = (index: number) => seed.companies[index]!;
  const adminClaims = (index = 0) => seed.claimsFor(seed.users.both, company(index).id);
  const cashierClaims = (index = 0) => seed.claimsFor(seed.users.cashier!, company(index).id);
  const companyIds = () => seed.companies.map((c) => c.id);

  const secretAs = async (claims: ReturnType<typeof cashierClaims>) => {
    const [row] = await withClaims(sql, claims, (tx) => tx`select secret from kernel.v_role_probe limit 1`);
    return row!.secret as string | null;
  };
  const modeAs = async (claims: ReturnType<typeof cashierClaims>) => {
    const [row] = await withClaims(sql, claims, (tx) => tx`select kernel.field_mode('kernel.role_probe', 'secret') as mode`);
    return row!.mode as string;
  };
  const visibleAs = async (claims: ReturnType<typeof cashierClaims>) => {
    const [row] = await withClaims(sql, claims, (tx) => tx`select kernel.field_visible('kernel.role_probe', 'secret') as v`);
    return row!.v as boolean;
  };
  const setMode = (companyIndex: number, roleId: string, mode: string) =>
    sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
        values (${company(companyIndex).id}, ${roleId}, 'kernel.role_probe', 'secret', ${mode})
        on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    seed = await seedTenant(sql, { companies: 2, users: [{ name: "cashier", companies: [0, 1], role: "member" }] });
    const [role] = await sql<{ id: string }[]>`
      insert into kernel.roles(company_id, name) values (${company(0).id}, 'extra') returning id`;
    extraRoleId = role!.id;
    for (const c of seed.companies) {
      await sql`insert into kernel.role_probe(company_id, secret) values (${c.id}, 's3')`;
    }
  });
  beforeEach(async () => {
    await sql`delete from kernel.field_permissions where company_id = any(${companyIds()}::uuid[])`;
  });
  afterAll(async () => {
    await sql`delete from kernel.role_probe where company_id = any(${companyIds()}::uuid[])`;
    // Deleting the roles cascades to their field permissions.
    await sql`delete from kernel.roles where id = ${extraRoleId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("a role with mode hidden reads null for that field through the view", async () => {
    await setMode(0, company(0).memberRoleId, "hidden");
    expect(await secretAs(cashierClaims())).toBeNull();
    expect(await secretAs(adminClaims())).toBe("s3");
    expect(await modeAs(cashierClaims())).toBe("hidden");
    expect(await visibleAs(cashierClaims())).toBe(false);
    expect(await modeAs(adminClaims())).toBe("visible");
    expect(await visibleAs(adminClaims())).toBe(true);
  });

  it("a role with mode masked also reads null and field_mode reports masked", async () => {
    await setMode(0, company(0).memberRoleId, "masked");
    expect(await secretAs(cashierClaims())).toBeNull();
    expect(await modeAs(cashierClaims())).toBe("masked");
    expect(await visibleAs(cashierClaims())).toBe(false);
  });

  it("without a permission row the field is visible", async () => {
    expect(await secretAs(cashierClaims())).toBe("s3");
    expect(await modeAs(cashierClaims())).toBe("visible");
  });

  it("with two roles the most restrictive mode wins", async () => {
    const claims = { ...cashierClaims(), role_ids: [company(0).memberRoleId, extraRoleId] };
    await setMode(0, company(0).memberRoleId, "hidden");
    await setMode(0, extraRoleId, "visible");
    expect(await secretAs(claims)).toBeNull();
    expect(await modeAs(claims)).toBe("hidden");

    await sql`delete from kernel.field_permissions where company_id = ${company(0).id}`;
    await setMode(0, company(0).memberRoleId, "masked");
    await setMode(0, extraRoleId, "visible");
    expect(await modeAs(claims)).toBe("masked");
    await setMode(0, extraRoleId, "hidden");
    expect(await modeAs(claims)).toBe("hidden");
  });

  it("another company's permission row does not affect this company", async () => {
    await setMode(1, company(1).memberRoleId, "hidden");
    expect(await secretAs(cashierClaims(1))).toBeNull();
    expect(await secretAs(cashierClaims(0))).toBe("s3");
    expect(await modeAs(cashierClaims(0))).toBe("visible");
  });

  it("a permission row of a role the caller does not hold in the active company is ignored", async () => {
    await setMode(0, extraRoleId, "hidden");
    expect(await secretAs(cashierClaims())).toBe("s3");
  });

  it("the view keeps the base table's company isolation", async () => {
    const rows = await withClaims(sql, cashierClaims(0), (tx) => tx`select company_id from kernel.v_role_probe`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.company_id).toBe(company(0).id);
  });

  it("only a company admin writes permissions, and only for roles of its own company", async () => {
    const insertAs = (claims: ReturnType<typeof cashierClaims>, rowCompanyIndex: number, roleId: string) =>
      withClaims(sql, claims, (tx) => tx`
        insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
        values (${company(rowCompanyIndex).id}, ${roleId}, 'kernel.role_probe', 'secret', 'hidden')`);

    await expect(insertAs(cashierClaims(), 0, company(0).memberRoleId)).rejects.toThrow(/row-level security/);
    await expect(insertAs(adminClaims(), 0, company(1).memberRoleId)).rejects.toThrow(/row-level security/);
    await expect(insertAs(adminClaims(), 1, company(1).memberRoleId)).rejects.toThrow(/row-level security/);
    await insertAs(adminClaims(), 0, company(0).memberRoleId);
    expect(await secretAs(cashierClaims())).toBeNull();

    // Everybody in the company reads the rules; a member cannot change or remove them.
    const visibleToMember = await withClaims(sql, cashierClaims(), (tx) => tx`select id from kernel.field_permissions`);
    expect(visibleToMember).toHaveLength(1);
    const removed = await withClaims(sql, cashierClaims(), (tx) => tx`delete from kernel.field_permissions returning id`);
    expect(removed).toHaveLength(0);
    expect(await secretAs(cashierClaims())).toBeNull();
  });

  it("changing a permission is audited", async () => {
    await setMode(0, company(0).memberRoleId, "masked");
    const [row] = await sql`select entity, action, diff from kernel.audit_log
      where entity = 'kernel.field_permissions' and company_id = ${company(0).id} order by occurred_at desc, id desc limit 1`;
    expect(row!.action).toBe("insert");
    expect(row!.diff).toMatchObject({ mode: { new: "masked" }, field: { new: "secret" } });
  });
});
