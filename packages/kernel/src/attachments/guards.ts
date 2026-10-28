import { ProcessError } from "../process/errors";
import type { ProcessContext } from "../process/context";
import type { ResolvedEntityDef } from "../registry/entities";
import type { RequiredKind } from "./required";

// The checks shared by the attachment processes and the route's pre-check. They run in a transaction
// under the caller's claims, so RLS, the masked views and kernel.can_run_process see the caller.

type Scope = Pick<ProcessContext, "tx" | "registry">;

/** The registered entity, or `invalid_input`. */
export function registeredEntity(scope: Pick<Scope, "registry">, entityId: string): ResolvedEntityDef {
  try {
    return scope.registry.entity(entityId);
  } catch {
    throw new ProcessError("invalid_input", `unknown entity ${entityId}`, { details: [`La entidad ${entityId} no existe`] });
  }
}

/** `not_found` unless the record is visible to the caller through the entity's masked view `<schema>.v_<table>`. */
export async function requireVisibleRecord(scope: Pick<Scope, "tx">, entity: ResolvedEntityDef, recordId: string): Promise<void> {
  const view = scope.tx(`${entity.schema}.v_${entity.table}`);
  const rows = await scope.tx`select 1 from ${view} where id = ${recordId}`;
  if (rows.length === 0) throw new ProcessError("not_found", `${entity.id} ${recordId} not found`);
}

/** `forbidden` unless a role of the caller may run `processId`. */
export async function requireProcess(scope: Pick<Scope, "tx">, processId: string, because: string): Promise<void> {
  const [row] = await scope.tx<{ allowed: boolean }[]>`select kernel.can_run_process(${processId}) as allowed`;
  if (!row?.allowed) throw new ProcessError("forbidden", `no role of the caller may run ${processId}${because}`);
}

/** `forbidden` unless a role of the caller may run `<entity>.update`, the owning entity's update process. */
export const requireOwnerUpdate = (scope: Pick<Scope, "tx">, entityId: string) =>
  requireProcess(scope, `${entityId}.update`, ", which attaching files requires");

/** The admin's definition of `tag` for the entity (trimmed, any case), or undefined for a free-form tag. */
export async function definedTag(
  tx: Scope["tx"],
  companyId: string,
  entityId: string,
  tag: string,
): Promise<{ tag: string; kind: RequiredKind } | undefined> {
  const [row] = await tx<{ tag: string; kind: RequiredKind }[]>`
    select tag, kind from kernel.required_attachments
    where company_id = ${companyId} and entity = ${entityId} and lower(btrim(tag)) = lower(btrim(${tag}))`;
  return row;
}
