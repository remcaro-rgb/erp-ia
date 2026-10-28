import { withClaims } from "../db/client";
import { ProcessError } from "../process/errors";
import type { Caller } from "../process/context";
import type { RunProcessDeps } from "../process/run";
import { definedTag, registeredEntity, requireOwnerUpdate, requireProcess, requireVisibleRecord } from "./guards";
import { addInput } from "./schemas";
import type { RequiredKind } from "./required";

/**
 * Everything `kernel.attachment.add` would refuse before it looks at the file itself, checked as the
 * caller so a route can refuse BEFORE it stores any bytes: the input shape (entity, record, tag), the
 * file name, type and size are valid, the entity is registered, the name is not taken, the caller may run `kernel.attachment.add` and `<entity>.update`, and the record
 * is visible to them. Returns the tag as the admin defined it and the file kind that tag requires
 * (`null` for a free-form tag) so the route can verify the content. Advisory: the process re-checks all
 * of it in its own transaction and is the one that audits.
 */
export async function precheckAttachment(
  deps: RunProcessDeps,
  caller: Caller,
  target: { entity: string; recordId: string; tag: string; fileName: string; mimeType: string; sizeBytes: number },
): Promise<{ tag: string; kind: RequiredKind | null }> {
  const shape = addInput.omit({ storagePath: true }).safeParse(target);
  if (!shape.success) throw new ProcessError("invalid_input", "invalid attachment target", { details: shape.error.issues });
  const { entity: entityId, recordId, tag, fileName } = shape.data;
  const entity = registeredEntity(deps, entityId);
  return withClaims(deps.sql, caller.claims, async (tx) => {
    await requireProcess({ tx }, "kernel.attachment.add", "");
    await requireOwnerUpdate({ tx }, entity.id);
    await requireVisibleRecord({ tx }, entity, recordId);
    const defined = await definedTag(tx, caller.claims.active_company_id, entity.id, tag);
    const same = await tx`
      select 1 from kernel.attachments
      where company_id = ${caller.claims.active_company_id} and entity = ${entity.id} and record_id = ${recordId}
        and removed_at is null and lower(file_name) = lower(${fileName})`;
    if (same.length > 0) {
      throw new ProcessError("invalid_input", "duplicate file name", { details: [`Ya existe un archivo ${fileName} en este registro`] });
    }
    return { tag: defined?.tag ?? tag, kind: defined?.kind ?? null };
  });
}
