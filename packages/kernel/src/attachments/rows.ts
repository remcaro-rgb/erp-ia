import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import type { ResolvedEntityDef } from "../registry/entities";
import { definedTag } from "./guards";

// The attachment row as the processes read and write it: the summary every process answers with, the select that
// builds it (with the uploader's name) and the one insert shared by an upload (`kernel.attachment.add`) and the AI
// photo suggestion (`kernel.ai.image_suggest`), so a stored file is checked the same way whoever stores it.

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

export interface AttachmentRow {
  id: string;
  entity: string;
  record_id: string;
  tag: string;
  file_name: string;
  mime_type: string;
  size_bytes: string;
  storage_path: string;
  position: number;
  suggested: boolean;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  uploaded_at: Date;
}

export const summary = (row: AttachmentRow) => ({
  id: row.id,
  entity: row.entity,
  recordId: row.record_id,
  tag: row.tag,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  position: row.position,
  suggested: row.suggested,
  uploadedBy: row.uploaded_by,
  uploadedByName: row.uploaded_by_name,
  uploadedAt: row.uploaded_at.toISOString(),
});

/** The attachment columns with the uploader's name, as a fragment to append `where …` to (kernel.users is visible to the company's members). */
export const selectAttachments = (ctx: ProcessContext) => ctx.tx`
  select a.id, a.entity, a.record_id, a.tag, a.file_name, a.mime_type, a.size_bytes, a.storage_path, a.position, a.suggested,
         a.created_by as uploaded_by, coalesce(u.full_name, u.email) as uploaded_by_name, a.created_at as uploaded_at
  from kernel.attachments a left join kernel.users u on u.id = a.created_by`;

export const refuse = (message: string, detail: string) => new ProcessError("invalid_input", message, { details: [detail] });

export interface NewAttachment {
  recordId: string;
  tag: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

/**
 * Registers a stored file against a record: the admin's spelling and file type of a defined tag, never a silent
 * overwrite of a live file of the same name, and a position after the record's other files. The caller has already
 * checked the owner's permission and that the record is visible, and has verified the storage path.
 */
export async function insertAttachment(
  ctx: ProcessContext,
  entity: ResolvedEntityDef,
  input: NewAttachment,
  options: { suggested?: boolean } = {},
): Promise<AttachmentRow> {
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
      insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path, position, suggested)
      values (
        ${ctx.companyId}, ${entity.id}, ${input.recordId}, ${tag}, ${input.fileName}, ${input.mimeType}, ${input.sizeBytes}, ${input.storagePath},
        (select coalesce(max(position) + 1, 0) from kernel.attachments
          where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${input.recordId} and removed_at is null),
        ${options.suggested ?? false})
      returning id`;
    id = inserted!.id;
  } catch (error) {
    // A concurrent upload of the same name or path committed between the check and the insert.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) throw duplicate;
    throw error;
  }
  const [row] = await ctx.tx<AttachmentRow[]>`${selectAttachments(ctx)} where a.id = ${id}`;
  return row!;
}
