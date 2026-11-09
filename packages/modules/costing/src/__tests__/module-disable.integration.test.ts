import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { entitled, syncRegistry } from "@erp/kernel";
import { costingHarness, type CostingHarness } from "./helpers";

// Owner item 112 (2026-11-09, F-4.1; rule 4): with the real manifests costing `dependsOn` inventory and inventory `needs` costing. A `needs`
// edge does not block disabling a module that itself depends on the needer, so Costos goes off while Inventario is on, and Inventario then
// goes off as usual. Disabling Inventario first is still refused (Costos depends on it).

describe("kernel.admin.module.disable with the real inventory and costing manifests (owner item 112)", () => {
  let h: CostingHarness;
  const disable = (moduleId: string) => h.runStepUp(h.admin, "kernel.admin.module.disable", { moduleId });
  const isOn = (moduleId: string) => entitled(h.sql, h.companyId, `module:${moduleId}`);

  beforeAll(async () => {
    h = await costingHarness();
    await syncRegistry(h.sql, h.registry);
    await h.sql`select kernel.seed_company_defaults(${h.companyId})`;
  });
  afterAll(async () => {
    await h.sql`delete from kernel.company_modules where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
    await h.sql`delete from kernel.sensitive_processes where company_id = any(${[h.companyId, h.otherCompanyId]}::uuid[])`;
    await h.cleanup();
  });

  it("disabling Inventario first is refused: Costos depends on it", async () => {
    expect(await isOn("inventory")).toBe(true);
    expect(await isOn("costing")).toBe(true);
    await expect(disable("inventory")).rejects.toMatchObject({ code: "invalid_input", details: ["El módulo costing depende de este; desactívalo primero"] });
    expect(await isOn("inventory")).toBe(true);
  });

  it("Costos can be disabled while Inventario (which needs it) is on; then Inventario is disabled as usual", async () => {
    expect(await disable("costing")).toEqual({ moduleId: "costing", enabled: false });
    expect(await isOn("costing")).toBe(false);
    expect(await isOn("inventory")).toBe(true);
    expect(await disable("inventory")).toEqual({ moduleId: "inventory", enabled: false });
    expect(await isOn("inventory")).toBe(false);
  });
});
