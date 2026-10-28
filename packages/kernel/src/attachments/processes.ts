import { ProcessError } from "../process/errors";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { definedTag, registeredEntity, requireOwnerUpdate, requireVisibleRecord } from "./guards";
import { addInput, addOutput, entityRecord, listOutput, removeInput, removeOutput } from "./schemas";

// Attachments on any entity (design §5.13, rule 22). The three processes are ordinary registered
// processes with their own permissions. add and remove also require the caller to be able to run the
// owning entity's update process (`<entity id>.update`), and every process needs the record to be
// visible through the entity's masked read view, so a party scope or a field mask that hides a record
// hides its files too.

const FEATURE = "kernel.attachments";
/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

interface AttachmentRow {
  id: string;
  entity: string;
  record_id: string;
  tag: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  storage_path: string;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: Date;
}

const summary = (row: AttachmentRow) => ({
  id: row.id,
  entity: row.entity,
  recordId: row.record_id,
  tag: row.tag,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  uploadedBy: row.uploaded_by,
  uploadedByName: row.uploaded_by_name,
  uploadedAt: row.uploaded_at.toISOString(),
});

/** The attachment columns with the uploader's name, as a fragment to append `where …` to (kernel.users is visible to the company's members). */
const selectAttachments = (ctx: ProcessContext) => ctx.tx`
  select a.id, a.entity, a.record_id, a.tag, a.file_name, a.mime_type, a.size_bytes, a.storage_path,
         a.created_by as uploaded_by, coalesce(u.full_name, u.email) as uploaded_by_name, a.created_at as uploaded_at
  from kernel.attachments a left join kernel.users u on u.id = a.created_by`;

const refuse = (message: string, detail: string) => new ProcessError("invalid_input", message, { details: [detail] });

export const attachmentAdd = defineProcess({
  id: "kernel.attachment.add",
  module: "kernel",
  kind: "update",
  feature: FEATURE,
  description: "Adjunta un archivo ya almacenado a un registro, con su etiqueta; exige poder actualizar la entidad dueña",
  input: addInput,
  output: addOutput,
  handler: async (ctx, input) => {
    const entity = registeredEntity(ctx, input.entity);
    await requireOwnerUpdate(ctx, entity.id);
    await requireVisibleRecord(ctx, entity, input.recordId);

    // The file must sit in this record's own folder: an upload can never point at another tenant's, company's or record's file.
    const folder = `${ctx.tenantId}/${ctx.companyId}/${entity.id}/${input.recordId}/`;
    const stored = input.storagePath.slice(folder.length);
    if (!input.storagePath.startsWith(folder) || stored === "" || stored.includes("/") || stored.includes("..")) {
      throw refuse("invalid storage path", "La ruta de almacenamiento no pertenece a este registro");
    }

    // A tag the admin defined keeps its defined spelling and its file type.
    const defined = await definedTag(ctx.tx, ctx.companyId, entity.id, input.tag);
    const tag = defined?.tag ?? input.tag;
    if (defined?.kind === "pdf" && input.mimeType !== "application/pdf") {
      throw refuse("tag requires a pdf", `La etiqueta ${tag} exige un archivo PDF`);
    }
    if (defined?.kind === "image" && !input.mimeType.startsWith("image/")) {
      throw refuse("tag requires an image", `La etiqueta ${tag} exige una imagen`);
    }

    // Never silently overwrite: a live file with this name (any case) on the record is a refusal.
    const duplicate = refuse("duplicate file name", `Ya existe un archivo ${input.fileName} en este registro`);
    const same = await ctx.tx`
      select 1 from kernel.attachments
      where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${input.recordId}
        and removed_at is null and lower(file_name) = lower(${input.fileName})`;
    if (same.length > 0) throw duplicate;

    let id: string;
    try {
      const [inserted] = await ctx.tx<{ id: string }[]>`
        insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path, created_by)
        values (${ctx.companyId}, ${entity.id}, ${input.recordId}, ${tag}, ${input.fileName}, ${input.mimeType}, ${input.sizeBytes}, ${input.storagePath}, ${ctx.userId})
        returning id`;
      id = inserted!.id;
    } catch (error) {
      // A concurrent upload of the same name or path committed between the check and the insert.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw duplicate;
      throw error;
    }
    const [row] = await ctx.tx<AttachmentRow[]>`${selectAttachments(ctx)} where a.id = ${id}`;
    return { ...summary(row!), storagePath: row!.storage_path };
  },
});

export const attachmentRemove = defineProcess({
  id: "kernel.attachment.remove",
  module: "kernel",
  kind: "delete",
  feature: FEATURE,
  description: "Quita un archivo adjunto (borrado lógico: la fila y el archivo se conservan para la auditoría)",
  input: removeInput,
  output: removeOutput,
  handler: async (ctx, { id }) => {
    const [row] = await ctx.tx<{ entity: string; record_id: string }[]>`
      select entity, record_id from kernel.attachments where id = ${id} and removed_at is null for update`;
    if (!row) throw new ProcessError("not_found", `attachment ${id} not found`);
    await requireOwnerUpdate(ctx, row.entity);
    // An entity this deployment no longer registers has no masked view to consult.
    if (ctx.registry.entities().some((e) => e.id === row.entity)) {
      await requireVisibleRecord(ctx, ctx.registry.entity(row.entity), row.record_id);
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
      order by a.created_at, a.id`;
    return rows.map(summary);
  },
});

export const ATTACHMENT_PROCESSES = [attachmentAdd, attachmentRemove, attachmentList];
