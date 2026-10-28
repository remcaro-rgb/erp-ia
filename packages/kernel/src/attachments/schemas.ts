import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "./limits";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "debe ser un UUID");

/** A file name is a name, not a path: no separators and no control characters. */
// eslint-disable-next-line no-control-regex
const FILE_NAME = /^[^/\\\u0000-\u001f]+$/;

export const entityRecord = z.object({ entity: z.string().min(1), recordId: uuid });

export const addInput = entityRecord.extend({
  /** Chosen from the entity's defined tags or typed freely; never blank. */
  tag: z.string().trim().min(1, "La etiqueta es obligatoria").max(80),
  fileName: z.string().trim().min(1).max(255).regex(FILE_NAME, "El nombre del archivo no puede contener rutas"),
  mimeType: z.string().trim().min(1).max(127),
  sizeBytes: z
    .number()
    .int()
    .min(1, "El archivo está vacío")
    .max(MAX_ATTACHMENT_BYTES, "El archivo supera los 25 MB"),
  storagePath: z.string().min(1).max(1024),
});

export const removeInput = z.object({ id: uuid });

/** The files of one record in their new order, first to last (the first photo is the principal one). */
export const reorderInput = entityRecord.extend({ orderedIds: z.array(uuid).min(1, "Indica los archivos en su nuevo orden").max(500) });
export const reorderOutput = z.object({ count: z.number().int() });

/** The attachment as every process that stores or lists files answers it. */
export const attachment = z.object({
  id: z.string(),
  entity: z.string(),
  recordId: z.string(),
  tag: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /** Display order within the record (0 first). */
  position: z.number().int(),
  /** A picture the assistant suggested that no user has approved yet. */
  suggested: z.boolean(),
  uploadedBy: z.string().nullable(),
  uploadedByName: z.string().nullable(),
  uploadedAt: z.string(),
});

export const addOutput = attachment.extend({ storagePath: z.string() });
export const listOutput = z.array(attachment);
export const removeOutput = z.object({ id: z.string() });
