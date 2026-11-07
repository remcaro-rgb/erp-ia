// Test helpers for integration suites of the kernel and the modules (`@erp/kernel/testing`).
// Kept out of the package root so application code never imports them.
export { testDb, seedTenant, ensureRoleProbe } from "./db/test-db";
export type { SeedOptions, SeededCompany, SeededTenant } from "./db/test-db";
export { withClaims } from "./db/client";
export type { JwtClaims, Tx } from "./db/client";
export { MemoryFileStore } from "./files/store";
export { buildZip, deflatedZeros, forgedZip, partOf, xlsxBook } from "./import/zip-fixtures";
export type { FixturePart } from "./import/zip-fixtures";
export { DbAuthAdmin } from "./db/test-auth-admin";

import type { ModuleDef } from "./registry/types";

/**
 * A bare module manifest for a harness that loads a module whose `needs` names a neighbour it cannot import (inventory needs costing,
 * which depends on inventory: a package cycle; plan 2B Task 41). Declares nothing; only satisfies the loader's `needs` check.
 */
export const needStub = (id: string): ModuleDef => ({
  id, version: "0", dependsOn: [], entities: [], processes: [], features: [], navigation: [], events: { emits: [], consumes: {} },
});
