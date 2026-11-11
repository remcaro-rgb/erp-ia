import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncRegistry } from "@erp/kernel";
import { accountingHarness, newId, type AccountingHarness } from "./helpers";

// Menu access on the accounting menu (entity types spec §9.2, Phase 2A.5 Task 10, review I1): a hidden item refuses the processes its
// screen runs, also those named by another noun than its entity (Períodos runs accounting.year.close and .reopen). The refusal is the
// very `forbidden` of a missing role permission.

let h: AccountingHarness;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code: string; message: string }) => ({ code: error.code, message: error.message }));

beforeAll(async () => {
  h = await accountingHarness();
  await syncRegistry(h.sql, h.deps.registry);
  await h.grantAll(h.companyId, h.contador.roleId, ["accounting.year.close", "accounting.year.reopen", "accounting.posting.retry"]);
}, 180_000);
afterAll(async () => {
  await h.cleanup();
});

const setPeriods = (rules: { roleId: string; allowed: boolean }[]) => h.runStepUp(h.admin, "kernel.menu_access.set", { navKey: "accounting.periods", rules });

describe("menu access on the accounting menu", () => {
  it("Períodos hidden for the contador: accounting.year.close and .reopen are refused with forbidden; other screens' processes are not", async () => {
    // Without rules the gate lets the contador through: the run fails later, on its (unknown) fiscal year.
    expect((await refusal(h.runStepUp(h.contador, "accounting.year.close", { fiscalYearId: newId() })))?.code).not.toBe("forbidden");

    await setPeriods([{ roleId: h.contador.roleId, allowed: false }]);
    try {
      for (const process of ["accounting.year.close", "accounting.year.reopen"]) {
        expect(await refusal(h.runStepUp(h.contador, process, { fiscalYearId: newId() }))).toMatchObject({ code: "forbidden" });
      }
      // The same refusal as a missing role permission: nothing more is revealed.
      await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${h.auxiliar.roleId} and process_id = 'accounting.year.close'`;
      const hidden = await refusal(h.runStepUp(h.contador, "accounting.year.close", { fiscalYearId: newId() }));
      const unpermitted = await refusal(h.runStepUp(h.auxiliar, "accounting.year.close", { fiscalYearId: newId() }));
      expect(hidden).toEqual(unpermitted);
      // Reglas contables is not hidden: its retry is still the contador's.
      expect((await refusal(h.runStepUp(h.contador, "accounting.posting.retry", { failureId: newId() })))?.code).not.toBe("forbidden");
      // The admin is never narrowed.
      expect((await refusal(h.runStepUp(h.admin, "accounting.year.close", { fiscalYearId: newId() })))?.code).not.toBe("forbidden");
    } finally {
      await setPeriods([]);
    }
  });
});
