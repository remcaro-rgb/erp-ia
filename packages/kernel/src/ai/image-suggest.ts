import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registeredEntity, requireOwnerUpdate, requireWritableRecord } from "../attachments/guards";
import { insertAttachment, summary } from "../attachments/rows";
import { attachment } from "../attachments/schemas";
import { fileStore } from "../files/store";
import { defineProcess } from "../process/define";
import { placeholderImage } from "./placeholder";

// "Sugerir foto con IA" (design §5.18, prototype `aiPhoto`): the assistant's picture for a record, stored as a file of
// the record tagged `Foto · IA` and marked `suggested` until a user approves it by making it the principal photo
// (`kernel.attachment.reorder` with it first clears the flag).
//
// Phase 1 draws a deterministic placeholder (see placeholder.ts). The real image model arrives in phase 5 behind THIS
// process, through the AI SDK and the model policy (rule 26), metered per user and company (rule 27); the input,
// the output and the audit entry stay as they are.

export const PHOTO_AI_TAG = "Foto · IA";

const input = z.object({
  entity: z.string().min(1),
  recordId: z.uuid(),
  description: z.string().trim().min(1, "La descripción es obligatoria").max(300),
  uom: z.string().trim().max(20).optional(),
  category: z.string().trim().max(100).optional(),
});

export const imageSuggest = defineProcess({
  id: "kernel.ai.image_suggest",
  module: "kernel",
  kind: "create",
  feature: "kernel.ai",
  recordAccess: "handler",
  description: "Sugiere una foto para un registro a partir de su descripción, unidad y categoría; queda como «Foto · IA» sugerida hasta que se haga la principal",
  input,
  output: attachment,
  handler: async (ctx, { entity: entityId, recordId, description, uom, category }) => {
    const entity = registeredEntity(ctx, entityId);
    // Adding a picture to the record needs the same right as uploading one.
    await requireOwnerUpdate(ctx, entity.id);
    await requireWritableRecord(ctx, entity, recordId);

    const image = placeholderImage({ description, uom, category });
    // The first free `sugerencia-ia-<n>.svg` of the record: asking again adds another, never overwrites.
    const taken = await ctx.tx<{ file_name: string }[]>`
      select file_name from kernel.attachments
      where company_id = ${ctx.companyId} and entity = ${entity.id} and record_id = ${recordId} and removed_at is null and file_name like 'sugerencia-ia-%'`;
    const used = new Set(taken.map((row) => row.file_name.toLowerCase()));
    let n = 1;
    while (used.has(`sugerencia-ia-${n}.svg`)) n += 1;
    const fileName = `sugerencia-ia-${n}.svg`;

    // The bytes go in first and are taken out again when the row is refused (a taken name, a tag that wants another
    // file type): a refusal never leaves a file behind. A dry run touches nothing outside the transaction.
    const storagePath = `${ctx.tenantId}/${ctx.companyId}/${entity.id}/${recordId}/${randomUUID()}-${fileName}`;
    const store = ctx.dryRun ? null : await fileStore();
    await store?.put(storagePath, image.bytes, image.mimeType);
    let row;
    try {
      row = await insertAttachment(
        ctx,
        entity,
        { recordId, tag: PHOTO_AI_TAG, fileName, mimeType: image.mimeType, sizeBytes: image.bytes.byteLength, storagePath },
        { suggested: true },
      );
    } catch (error) {
      await store?.remove(storagePath).catch((cleanup: unknown) => console.error("suggested picture cleanup failed", cleanup));
      throw error;
    }
    return summary(row);
  },
});

export const AI_PROCESSES = [imageSuggest];
