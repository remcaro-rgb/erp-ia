import { describe, expect, it } from "vitest";
import { kernelModule, loadModules, Registry, uncoveredRecordWrites } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { support } from "@erp/module-support";

// Record-level access (spec 2026-11-02 §9.1, review I4 of Task 9): no process of the shipped modules may change a maestro or
// documento without the runProcess guard or an explicit `recordAccess` declaration.
describe("record-level access coverage", () => {
  it("every create / update / delete process that can change a typed record is guarded by name or declares its target", () => {
    const registry = new Registry();
    loadModules(registry, [kernelModule, core, accounting, support]);
    expect(uncoveredRecordWrites(registry)).toEqual([]);
  });
});
