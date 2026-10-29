import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JwtClaims } from "@erp/kernel";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { linkableEntities } from "@/lib/grid/links";
import { processDeps } from "@/lib/server/runtime";

// A reference to a user links to their page under Administración › Usuarios only for a caller who can open it, the
// company admin (design §22.15, rule 21; final review M-2). Anyone else who may consult users reads the name as plain
// text; the other entities keep their own rule (a page and the entity's consult).

let member: AuthFixture;
let admin: AuthFixture;

const claimsOf = async (fixture: AuthFixture): Promise<JwtClaims> => {
  const companyId = fixture.companyIds[0]!;
  const roles = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
  return { sub: fixture.userId, tenant_id: fixture.tenantId, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" };
};

beforeAll(async () => {
  member = await seedAuthUser({ role: "member" });
  admin = await seedAuthUser({ role: "admin" });
  for (const fixture of [member, admin]) {
    const companyId = fixture.companyIds[0]!;
    await fixture.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${fixture.tenantId}, 'module:core', 'manual')`;
    const [{ id: roleId }] = await fixture.sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId}`;
    for (const process of ["kernel.user.consult", "core.party.consult"]) {
      await fixture.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${roleId!}, ${process})`;
    }
  }
});

afterAll(async () => {
  for (const fixture of [member, admin]) {
    await fixture.sql`delete from kernel.process_permissions where company_id = any(${fixture.companyIds}::uuid[])`;
    await fixture.sql`delete from kernel.tenant_entitlements where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
  }
});

describe("linkableEntities and the users' pages", () => {
  it("a member who may consult users gets no user link; their other links stay", async () => {
    const linkable = await linkableEntities(processDeps(), await claimsOf(member), ["kernel.user", "core.party"]);
    expect(linkable.has("kernel.user")).toBe(false);
    expect(linkable.has("core.party")).toBe(true);
  });

  it("the company admin gets the user link", async () => {
    const linkable = await linkableEntities(processDeps(), await claimsOf(admin), ["kernel.user", "core.party"]);
    expect(linkable.has("kernel.user")).toBe(true);
    expect(linkable.has("core.party")).toBe(true);
  });
});
