import type { CustomFieldCaller, CustomFieldDef, ExtraData } from "./types";

/** Whether one of the caller's roles is in `allowed`. */
export const roleIn = (caller: CustomFieldCaller, allowed: readonly string[]): boolean => caller.roleIds.some((id) => allowed.includes(id));

/** Whether the caller's roles may see the field's value (`roles_view`). */
export const canView = (def: Pick<CustomFieldDef, "rolesView">, caller: CustomFieldCaller): boolean => roleIn(caller, def.rolesView);

/**
 * A copy of `extra` without the keys the caller may not view, the mirror of field masking
 * (rule 14) for admin-defined fields. A key nobody defined (its definition was removed) is hidden
 * from everybody, so removing a field never exposes the data it protected. Consults call this
 * before returning a record.
 */
export function stripInvisible(defs: readonly CustomFieldDef[], extra: ExtraData | null | undefined, caller: CustomFieldCaller): ExtraData {
  const visible = new Set(defs.filter((def) => canView(def, caller)).map((def) => def.key));
  return Object.fromEntries(Object.entries(extra ?? {}).filter(([key]) => visible.has(key)));
}
