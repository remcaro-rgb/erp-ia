import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims, type JwtClaims } from "../../db/client";
import { ensureRoleProbe, seedTenant, testDb } from "../../db/test-db";
import { Registry } from "../../registry";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { runProcess } from "../../process/run";
import type { Caller } from "../../process/context";
import { SYSTEM_USER_ID } from "../../events/consumers";
import { syncRegistry } from "../sync";

// Migration 0024 (final review I1): a role the admin takes away stops counting at once, not when the user's token is
// refreshed. kernel.current_role_ids() keeps only the claim's roles the user still holds in the active company, so every
// helper built on it (is_company_admin, can_run_process, field_mode, mask_extra, party_scope, the recommendation
// policies) refuses with the old claims. The service connection and the kernel's system user are not members and keep
// working as before.

describe("kernel role claims: revocation applies before the token refresh", () => {
  let sql: ReturnType<typeof testDb>;
  let seed: Awaited<ReturnType<typeof seedTenant>>;
  let registry: Registry;
  let companyId: string;
  let adminRoleId: string;
  let memberRoleId: string;
  let admin: Caller;
  /** The claims `boss` received while holding admin + member: reused after the admin role is taken away. */
  let oldBossClaims: JwtClaims;

  const probe = async (claims: JwtClaims) => {
    const [row] = await withClaims(
      sql,
      claims,
      (tx) => tx<{ role_ids: string[]; admin: boolean; can: boolean; mode: string; secret: string | null }[]>`
        select kernel.current_role_ids() as role_ids,
               kernel.is_company_admin() as admin,
               kernel.can_run_process('kernel.admin.permission.set') as can,
               kernel.field_mode('kernel.role_probe', 'secret') as mode,
               (select secret from kernel.v_role_probe limit 1) as secret`,
    );
    return row!;
  };

  beforeAll(async () => {
    sql = testDb();
    await ensureRoleProbe(sql);
    registry = new Registry();
    loadModules(registry, [kernelModule]);
    seed = await seedTenant(sql, { companies: 1, entitlements: [], users: [{ name: "boss", companies: [0], role: "member" }] });
    companyId = seed.companies[0]!.id;
    adminRoleId = seed.companies[0]!.adminRoleId;
    memberRoleId = seed.companies[0]!.memberRoleId;
    await syncRegistry(sql, registry);
    await sql`select kernel.seed_company_defaults(${companyId})`;
    // boss also holds the admin role; the member role sees the probe's secret masked.
    await sql`insert into kernel.membership_roles(membership_id, role_id)
      select id, ${adminRoleId} from kernel.memberships where company_id = ${companyId} and user_id = ${seed.users.boss!}`;
    await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode)
      values (${companyId}, ${memberRoleId}, 'kernel.role_probe', 'secret', 'masked')
      on conflict (company_id, role_id, entity, field) do update set mode = excluded.mode`;
    await sql`insert into kernel.role_probe(company_id, secret) values (${companyId}, 's3')`;
    admin = { claims: seed.claimsFor(seed.users.both, companyId), origin: "ui" };
    oldBossClaims = { ...seed.claimsFor(seed.users.boss!, companyId), role_ids: [adminRoleId, memberRoleId] };
  });
  afterAll(async () => {
    await sql`delete from kernel.role_probe where company_id = ${companyId}`;
    await seed.cleanup();
    await sql.end();
  });

  it("with the roles still held, the claims count as they are", async () => {
    const before = await probe(oldBossClaims);
    expect(before.role_ids.sort()).toEqual([adminRoleId, memberRoleId].sort());
    expect(before).toMatchObject({ admin: true, can: true, mode: "visible", secret: "s3" });
  });

  it("a claim naming a role the user never held does not count", async () => {
    const forged = { ...seed.claimsFor(seed.users.onlyA, companyId), role_ids: [memberRoleId] };
    // onlyA holds the admin role only: the member role in the claim is dropped.
    expect((await probe(forged)).role_ids).toEqual([]);
  });

  it("after user_role.set removes the admin role, the old claims no longer grant it", async () => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${admin.claims.sub}, ${companyId}, ${stepUpToken})`;
    await runProcess({ sql, registry }, { ...admin, stepUpToken }, "kernel.admin.user_role.set", { userId: seed.users.boss!, roleIds: [memberRoleId] });

    const after = await probe(oldBossClaims);
    expect(after.role_ids).toEqual([memberRoleId]);
    expect(after).toMatchObject({ admin: false, can: false, mode: "masked", secret: null });
    await expect(runProcess({ sql, registry }, { claims: oldBossClaims, origin: "ui" }, "kernel.admin.permission.matrix", {})).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("the service connection and the kernel's system user are unaffected", async () => {
    const [service] = await sql<{ role_ids: string[]; secret: string }[]>`
      select kernel.current_role_ids() as role_ids, (select secret from kernel.role_probe where company_id = ${companyId} limit 1) as secret`;
    expect(service).toEqual({ role_ids: [], secret: "s3" });
    const system: JwtClaims = { sub: SYSTEM_USER_ID, tenant_id: seed.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: [adminRoleId], locale: "es-419" };
    expect(await probe(system)).toMatchObject({ role_ids: [adminRoleId], admin: true, can: true, mode: "visible", secret: "s3" });
  });
});
