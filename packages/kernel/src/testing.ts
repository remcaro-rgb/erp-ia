// Test helpers for integration suites of the kernel and the modules (`@erp/kernel/testing`).
// Kept out of the package root so application code never imports them.
export { testDb, seedTenant, ensureRoleProbe } from "./db/test-db";
export type { SeedOptions, SeededCompany, SeededTenant } from "./db/test-db";
export { withClaims } from "./db/client";
export type { JwtClaims, Tx } from "./db/client";
