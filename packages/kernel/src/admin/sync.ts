import type { Sql } from "postgres";
import { syncModuleManifestIfChanged } from "../entitlements/resolver";
import type { Registry } from "../registry";

/**
 * Registers every loaded module's manifest in SQL (design §5.2: the kernel registers the manifests at boot): features,
 * processes with their kind and step-up, and entity fields with their sensitivity, which the role seeds and the admin
 * processes read. Service connection; idempotent. A module whose manifest is the one already registered is not rewritten (0061).
 */
export async function syncRegistry(sql: Sql, registry: Registry): Promise<void> {
  for (const module of registry.modules()) await syncModuleManifestIfChanged(sql, module);
}
