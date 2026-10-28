import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedAuthUser, type AuthFixture } from "../../../../test-support/auth-fixtures";
import { MemoryJar } from "../../../../test-support/memory-jar";

const state = vi.hoisted(() => ({ jar: undefined as unknown }));
vi.mock("next/headers", () => ({ cookies: async () => state.jar }));

import { setActiveCompany } from "@/lib/auth/active-company";
import { getCallerClaims } from "@/lib/auth/claims";
import { loginWithPassword } from "@/lib/auth/login";

let fixture: AuthFixture;
let other: AuthFixture;

beforeAll(async () => {
  fixture = await seedAuthUser({ role: "member", companies: 2 });
  other = await seedAuthUser({ role: "member" });
  const jar = new MemoryJar();
  state.jar = jar;
  await loginWithPassword(jar, { email: fixture.email, password: fixture.password, remember: false });
});

afterAll(async () => {
  await fixture.cleanup();
  await other.cleanup();
});

describe("setActiveCompany", () => {
  it("starts in the first company, switches to another the user belongs to and reissues the claims", async () => {
    const first = await getCallerClaims();
    expect(first.active_company_id).toBe(fixture.companyIds[0]);
    expect(first.company_ids).toEqual(fixture.companyIds);

    await setActiveCompany(fixture.companyIds[1]!);
    const switched = await getCallerClaims();
    expect(switched.active_company_id).toBe(fixture.companyIds[1]);
    // The roles are those of the new company's membership.
    expect(switched.role_ids).toHaveLength(1);
    expect(switched.role_ids).not.toEqual(first.role_ids);

    const audit = await fixture.sql<{ origin: string; entity: string; row_id: string; company_id: string; input: unknown }[]>`
      select origin, entity, row_id, company_id, input from kernel.audit_log
      where process_id = 'auth.company.switch' and actor_user_id = ${fixture.userId}`;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      origin: "ui",
      entity: "kernel.users",
      row_id: fixture.userId,
      company_id: fixture.companyIds[1],
      input: { from: fixture.companyIds[0], to: fixture.companyIds[1] },
    });
  });

  it("refuses a company the user is not a member of and keeps the session as it was", async () => {
    const before = await getCallerClaims();
    await expect(setActiveCompany(other.companyIds[0]!)).rejects.toMatchObject({ code: "forbidden" });
    await expect(setActiveCompany("not-a-uuid")).rejects.toMatchObject({ code: "forbidden" });
    expect((await getCallerClaims()).active_company_id).toBe(before.active_company_id);
    const [{ metadata }] = await fixture.sql<{ metadata: { active_company_id?: string } }[]>`
      select raw_app_meta_data as metadata from auth.users where id = ${fixture.userId}`;
    expect(metadata.active_company_id).toBe(before.active_company_id);
  });
});
