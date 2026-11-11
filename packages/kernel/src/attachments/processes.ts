import { ProcessError } from "../process/errors";
import { defineProcess } from "../process/define";
import { registeredEntity, requireOwnerUpdate, requireVisibleRecord, requireWritableRecord } from "./guards";
import { insertAttachment, refuse, selectAttachments, summary, type AttachmentRow } from "./rows";
import { addInput, addOutput, entityRecord, listOutput, removeInput, removeOutput, reorderInput, reorderOutput } from "./schemas";

// Attachments on any entity (design §5.13, rule 22). The processes are ordinary registered processes with
// their own permissions. add, remove and reorder also require the caller to be able to run the owning entity's
// update process (`<entity id>.update`, or the entity's declared `processIds.attach`), and every process needs the
// record to be visible through the entity's masked read view, so a party scope or a field mask that hides a record
// hides its files too.

const FEATURE = "kernel.attachments";

export const attachmentAdd = defineProcess({
  id: "kernel.attachment.add",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description: "Adjunta un archivo ya almacenado a un registro, con su etiqueta; exige poder actualizar la entidad dueña",
  recordAccess: "handler",
  input: addInput,
  output: addOutput,
  handler: async (ctx, input) => {
    const entity = registeredEntity(ctx, input.entity);
    await requireOwnerUpdate(ctx, entity.id);
    await requireWritableRecord(ctx, entity, input.recordId);

    // The file must sit in this record's own folder: an upload can never point at another tenant's, company's or record's file.
    const folder = `${ctx.tenantId}/${ctx.companyId}/${entity.id}/${input.recordId}/`;
    const stored = input.storagePath.slice(folder.length);
    if (!input.storagePath.startsWith(folder) || stored === "" || stored.includes("/") || stored.includes("..")) {
      throw refuse("invalid storage path", "La ruta de almacenamiento no pertenece a este registro");
    }
    const row = await insertAttachment(ctx, entity, input);
    return { ...summary(row), storagePath: row.storage_path };
  },
});

export const attachmentRemove = defineProcess({
  id: "kernel.attachment.remove",
  module: "kernel",
  kind: "delete",
  feature: FEATURE,
  description: "Quita un archivo adjunto (borrado lógico: la fila y el archivo se conservan para la auditoría)",
  recordAccess: "handler",
  input: removeInput,
  output: removeOutput,
  handler: async (ctx, { id }) => {
    const [row] = await ctx.tx<{ entity: string; record_id: string }[]>`
      select entity, record_id from kernel.attachments where id = ${id} and removed_at is null for update`;
    if (!row) throw new ProcessError("not_found", `attachment ${id} not found`);
    await requireOwnerUpdate(ctx, row.entity);
    // An entity this deployment no longer registers has no masked view to consult.
    if (ctx.registry.entities().some((e) => e.id === row.entity)) {
      await requireWritableRecord(ctx, ctx.registry.entity(row.entity), row.record_id);
    }
    await ctx.tx`update kernel.attachments set removed_at = now(), removed_by = ${ctx.userId} where id = ${id}`;
    return { id };
  },
});

export const attachmentList = defineProcess({
  id: "kernel.attachment.list",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Lista los archivos adjuntos vigentes de un registro",
  input: entityRecord,
  output: listOutput,
  handler: async (ctx, input) => {
    const entity = registeredEntity(ctx, input.entity);
    await requireVisibleRecord(ctx, entity, input.recordId);
    const rows = await ctx.tx<AttachmentRow[]>`
      ${selectAttachments(ctx)}
      where a.company_id = ${ctx.companyId} and a.entity = ${entity.id} and a.record_id = ${input.recordId} and a.removed_at is null
      order by a.position, a.created_at, a.id`;
    return rows.map(summary);
  },
});

export const attachmentReorder = defineProcess({
  id: "kernel.attachment.reorder",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description:
    "Cambia el orden de los archivos adjuntos de un registro (la primera foto es la principal); la foto sugerida por IA que queda primera se da por aprobada",
  recordAccess: "handler",
  input: reorderInput,
  output: reorderOutput,
  handler: async (ctx, { entity: entityId, recordId, orderedIds }) => {
    const entity = registeredEntity(ctx, entityId);
    await requireOwnerUpdate(ctx, entity.id);
    await requireWritableRecord(ctx, entity, recordId);
    if (new Set(orderedIds).size !== orderedIds.length) throw refuse("repeated attachment", "Un archivo aparece más de una vez en el orden");

    // Every id must be a live file of this record. The rows are locked in id order, so two reorders of the same record
    // queue up instead of deadlocking.
    const found = await ctx.tx<{ id: string }[]>`
      select id from kernel.attachments
      where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${recordId} and removed_at is null
        and id = any (${orderedIds}::uuid[])
      order by id
      for update`;
    if (found.length !== orderedIds.length) throw refuse("attachment not on the record", "Algún archivo no pertenece a este registro o ya fue quitado");

    // Positions 0..n-1 in the given order. Only the files named are renumbered: a list of the photos alone leaves the
    // record's other files where they were (the Archivos list sorts by position, then upload time). Approval of a suggested picture: the one placed first is no longer a suggestion.
    await ctx.tx`
      update kernel.attachments a
      set position = o.pos - 1, suggested = case when o.pos = 1 then false else a.suggested end
      from unnest(${orderedIds}::uuid[]) with ordinality as o (id, pos)
      where a.id = o.id and (a.position is distinct from o.pos - 1 or (o.pos = 1 and a.suggested))`;
    return { count: orderedIds.length };
  },
});

export const ATTACHMENT_PROCESSES = [attachmentAdd, attachmentRemove, attachmentList, attachmentReorder];
