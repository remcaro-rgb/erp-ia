import type { ExtraDataValue } from "@erp/ui";

/**
 * What the Datos adicionales tab sends on Guardar (the entity's update process): only the keys of `extra` the user
 * changed (`extraPatch`, `null` for a removed key), so a form loaded earlier cannot overwrite what somebody else saved
 * meanwhile, and the free pairs as a whole, only when they changed. Nothing changed: an empty object.
 */
export function extraChanges(baseline: ExtraDataValue, current: ExtraDataValue): { extraPatch?: Record<string, unknown>; extraFree?: ExtraDataValue["extraFree"] } {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current.extra)) {
    if (!(key in baseline.extra) || !same(baseline.extra[key], value)) patch[key] = value;
  }
  for (const key of Object.keys(baseline.extra)) if (!(key in current.extra)) patch[key] = null;
  return {
    ...(Object.keys(patch).length > 0 ? { extraPatch: patch } : {}),
    ...(same(baseline.extraFree, current.extraFree) ? {} : { extraFree: current.extraFree }),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
