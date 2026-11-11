import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitled, kernelModule, loadModules, Registry, runProcess, syncRegistry, type Caller, type ModuleDef } from "@erp/kernel";
import { core } from "@erp/module-core";
import { support } from "../index";
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
    // A role created while support was off gets support's consults when support comes back.
    const [fresh] = await h.sql<{ id: string }[]>`insert into kernel.roles(company_id, name) values (${h.companyId}, 'nuevo') returning id`;
    await run("kernel.admin.module.enable", { moduleId: "core" });
    await run("kernel.admin.module.enable", { moduleId: "support" });
    expect(await isOn("support")).toBe(true);
    const grants = await h.sql<{ process_id: string }[]>`select process_id from kernel.process_permissions where role_id = ${fresh!.id} order by process_id`;
    expect(grants.map((g) => g.process_id)).toEqual(expect.arrayContaining(["support.ticket.consult", "support.ticket_message.consult"]));
    expect(grants.map((g) => g.process_id)).not.toContain("support.ticket.create");
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

  // `ModuleDef.needs` (plan 2B Task 41, Ruling R41-1): a soft neighbour that is not a load-order edge. A bare module "buyer" stands in for
  // inventory and support for costing: buyer needs support, support does not depend on buyer.
  it("disabling a module is refused while an enabled module needs it; allowed once the needer is off", async () => {
    const buyer: ModuleDef = {
      id: "buyer", version: "1", dependsOn: ["core"], needs: ["support"], entities: [], processes: [], features: [], navigation: [],
      events: { emits: [], consumes: {} },
    };
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, support, buyer]);
    const deps = { ...h.deps, registry };
    const asAdmin = async (processId: string, input: unknown) => runProcess(deps, await stepUp(admin), processId, input);
    await h.sql`insert into kernel.tenant_entitlements(tenant_id, key, source) values (${h.seed.tenantId}, 'module:buyer', 'manual')`;
    try {
      await expect(asAdmin("kernel.admin.module.disable", { moduleId: "support" })).rejects.toMatchObject({
        code: "invalid_input", details: ["El módulo buyer necesita este módulo; desactívalo primero"],
      });
      expect(await isOn("support")).toBe(true);
      // Enabling the needer never forced the needed module on: switch the needer off and support can go.
      await asAdmin("kernel.admin.module.disable", { moduleId: "buyer" });
      await asAdmin("kernel.admin.module.disable", { moduleId: "support" });
      expect(await isOn("support")).toBe(false);
    } finally {
      await h.sql`delete from kernel.tenant_entitlements where tenant_id = ${h.seed.tenantId} and key = 'module:buyer'`;
      await h.sql`delete from kernel.company_modules where company_id = ${h.companyId}`;
    }
  });
});
