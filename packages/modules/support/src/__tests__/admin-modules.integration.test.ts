import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitled, runProcess, syncRegistry, type Caller } from "@erp/kernel";
import { supportHarness, type SupportHarness } from "./helpers";

// Modules on and off per company (design §5.12, rule 4) through kernel.admin.module.enable / disable, with the real
// dependency of support on core: core cannot be switched off while support is on, a disabled module's processes stop
// being entitled (so its menus, exports and assistant tools disappear), and switching it on again restores them.

describe("admin: modules", () => {
  let h: SupportHarness;
  let admin: Caller;

  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await h.sql`insert into kernel.step_up_verifications(user_id, company_id, token)
                values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = async (processId: string, input: unknown) => runProcess(h.deps, await stepUp(admin), processId, input);
  const isOn = async (moduleId: string) => entitled(h.sql, h.companyId, `module:${moduleId}`);

  beforeAll(async () => {
    h = await supportHarness();
    await h.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${h.seed.tenantId}, 'module:core', 'manual')`;
    await syncRegistry(h.sql, h.deps.registry);
    await h.sql`select kernel.seed_company_defaults(${h.companyId})`;
    admin = { claims: h.seed.claimsFor(h.seed.users.both, h.companyId), origin: "ui" };
  });
  afterAll(async () => {
    await h.sql`delete from kernel.sensitive_processes where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
    await h.cleanup();
  });

  it("disabling core is refused while support, which depends on it, is enabled", async () => {
    expect(await isOn("core")).toBe(true);
    expect(await isOn("support")).toBe(true);
    await expect(run("kernel.admin.module.disable", { moduleId: "core" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await isOn("core")).toBe(true);
    await expect(run("kernel.admin.module.disable", { moduleId: "kernel" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("disabling support withdraws its processes; enabling it again restores them", async () => {
    await run("kernel.admin.module.disable", { moduleId: "support" });
    expect(await isOn("support")).toBe(false);
    await expect(runProcess(h.deps, h.reporterA, "support.ticket.consult", { id: randomUUID() })).rejects.toMatchObject({ code: "not_entitled" });

    // With support off, core may go too; core cannot come back after support… support needs core first.
    await run("kernel.admin.module.disable", { moduleId: "core" });
    await expect(run("kernel.admin.module.enable", { moduleId: "support" })).rejects.toMatchObject({ code: "invalid_input" });
    await run("kernel.admin.module.enable", { moduleId: "core" });
    await run("kernel.admin.module.enable", { moduleId: "support" });
    expect(await isOn("support")).toBe(true);
    expect(await isOn("core")).toBe(true);
  });

  it("a module the tenant has not bought cannot be enabled", async () => {
    await h.sql`delete from kernel.tenant_entitlements where tenant_id = ${h.seed.tenantId} and key = 'module:core'`;
    try {
      await run("kernel.admin.module.disable", { moduleId: "support" });
      await run("kernel.admin.module.disable", { moduleId: "core" });
      await expect(run("kernel.admin.module.enable", { moduleId: "core" })).rejects.toMatchObject({ code: "not_entitled" });
    } finally {
      await h.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${h.seed.tenantId}, 'module:core', 'manual')`;
      await h.sql`delete from kernel.company_modules where company_id = ${h.companyId}`;
    }
  });
});
