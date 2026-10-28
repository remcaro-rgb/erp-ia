import type { ProcessContext } from "../process/context";
import { loadCustomFields } from "./store";
import { CUSTOM_MISSING_PREFIX, type ExtraData } from "./types";
import { validateCustomFields } from "./validate";
import { stripInvisible } from "./visibility";

// What an entity's create / update process does with a record's `extra` (design §5.14). Shared by every
// module that stores extra data, so the rules live once.

type Scope = Pick<ProcessContext, "tx" | "roleIds">;

export interface CustomData {
  /** The `extra` to store. */
  extra: ExtraData;
  /** Reasons to refuse the write (`invalid_input`). */
  errors: string[];
  /** "Dato adicional: <label>" for every required field left empty: add them to the record's `dian_missing`. */
  missing: string[];
}

/**
 * Validates the `extra` a process was given against the company's definitions for `entityId`.
 *
 * `given` is the caller's whole extra document or undefined when the request does not touch it; `patch` instead
 * names only the keys to set (`null` removes one) and is merged into the stored document. Keys the
 * caller may not view were never sent to them, so they are carried over from `stored` instead of being
 * erased by the replacement. Values that do not change need no role and are not re-checked, so a stricter
 * definition never breaks an unrelated update; a required field left empty is reported as `missing`.
 */
export async function customData(
  scope: Scope,
  entityId: string,
  stored: ExtraData | null | undefined,
  given: ExtraData | undefined,
  patch?: Record<string, unknown>,
): Promise<CustomData> {
  const defs = await loadCustomFields(scope.tx, entityId);
  const caller = { roleIds: scope.roleIds };
  const before = stored ?? {};
  if (patch !== undefined) {
    // A patch names the keys that change and leaves every other stored key as it is, so a form loaded earlier cannot
    // overwrite what somebody saved meanwhile; `null` removes a key. It becomes the whole document the caller would have
    // sent: what they may view, with the changes applied. Everything else (hidden keys, validation) is as for `given`.
    if (given !== undefined) return { extra: before, errors: ["Envía extra o extraPatch, no ambos"], missing: [] };
    if (Object.keys(patch).some((key) => key === "__proto__" || key === "constructor" || key === "prototype")) {
      return { extra: before, errors: ["Clave no permitida en extraPatch"], missing: [] };
    }
    const next: Record<string, unknown> = { ...stripInvisible(defs, before, caller) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    given = next;
  }
  if (given === undefined) {
    const { missing } = validateCustomFields(defs, before, caller, before);
    return { extra: before, errors: [], missing: missing.map((label) => CUSTOM_MISSING_PREFIX + label) };
  }
  const visible = stripInvisible(defs, before, caller);
  const hidden = Object.fromEntries(Object.entries(before).filter(([key]) => !(key in visible)));
  const extra = { ...hidden, ...given };
  const { errors, missing } = validateCustomFields(defs, extra, caller, before);
  return { extra, errors, missing: missing.map((label) => CUSTOM_MISSING_PREFIX + label) };
}

/**
 * `extra` as the caller may see it (`roles_view`): what a consult returns. A null (the whole column is
 * masked by field permissions) stays null.
 */
export async function visibleExtra(scope: Scope, entityId: string, extra: ExtraData | null | undefined): Promise<ExtraData | null> {
  if (extra === null || extra === undefined) return null;
  return stripInvisible(await loadCustomFields(scope.tx, entityId), extra, { roleIds: scope.roleIds });
}
