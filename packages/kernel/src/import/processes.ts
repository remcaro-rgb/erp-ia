import { z } from "zod";
import { requireProcess } from "../attachments/guards";
import { MAX_ATTACHMENT_BYTES } from "../attachments/limits";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { importColumns, importTarget } from "./columns";
import { importFormatOf } from "./format";

// The import processes (design §5.11, §9, rule 20). They are kernel processes: the target entity is any registered
// entity with a create process, resolved from the registry, never named here. The template and the preview only
// read; `kernel.import.run` creates the import record (sensitive by default: an admin-level bulk write) and the
// workflow of import/run.ts does the rest as the same caller.

const FEATURE = "kernel.imports";

// eslint-disable-next-line no-control-regex
const FILE_NAME = /^[^/\\\u0000-\u001f]+$/;

const entityInput = z.object({ entity: z.string().min(1).max(100) });
const fileName = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(FILE_NAME, "El nombre del archivo no puede contener rutas")
  .refine((name) => importFormatOf(name) !== null, "El archivo debe ser .xlsx o .csv");

const sizeBytes = z.number().int().min(1, "El archivo está vacío").max(MAX_ATTACHMENT_BYTES, "El archivo supera los 25 MB");

const column = z.object({
  key: z.string(),
  field: z.string(),
  label: z.string(),
  type: z.enum(["text", "number", "boolean", "list", "multi", "ref"]),
  required: z.boolean(),
  options: z.array(z.string()).optional(),
  ref: z.object({ entity: z.string(), display: z.string() }).optional(),
});
const columnsOutput = z.object({ entity: z.string(), createProcess: z.string(), columns: z.array(column) });

/** The target and its columns; refuses (forbidden) a caller who could not create records of the entity anyway. */
async function target(ctx: ProcessContext, entityId: string) {
  const { entity, createProcess } = importTarget(ctx.registry, entityId);
  await requireProcess(ctx, createProcess.id, ", which importing into its entity requires");
  return { entity: entity.id, createProcess: createProcess.id, columns: importColumns(ctx.registry, entity.id) };
}

export const importTemplate = defineProcess({
  id: "kernel.import.template",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Describe las columnas de la plantilla de importación (Excel o CSV) de una entidad",
  input: entityInput,
  output: columnsOutput,
  handler: async (ctx, input) => target(ctx, input.entity),
});

export const importPreview = defineProcess({
  id: "kernel.import.preview",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Revisa un archivo de importación antes de cargarlo: columnas y validación fila a fila sin guardar nada",
  input: entityInput.extend({ fileName, sizeBytes }),
  output: columnsOutput,
  handler: async (ctx, input) => target(ctx, input.entity),
});

export const importRun = defineProcess({
  id: "kernel.import.run",
  module: "kernel",
  kind: "create",
  feature: FEATURE,
  sensitivity: "step-up",
  description: "Importa un archivo Excel o CSV a una entidad: crea solo las filas válidas y devuelve errores.csv con las rechazadas",
  input: entityInput.extend({
    fileName,
    mimeType: z.string().trim().min(1).max(127),
    sizeBytes,
  }),
  output: z.object({ id: z.string(), importId: z.string() }),
  handler: async (ctx, input) => {
    const { entity } = await target(ctx, input.entity);
    // The source file and errores.csv are attachments of the import record.
    await requireProcess(ctx, "kernel.attachment.add", ", which keeping the imported file requires");
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into kernel.imports (company_id, entity, started_by, created_by)
      values (${ctx.companyId}, ${entity}, ${ctx.userId}, ${ctx.userId})
      returning id`;
    return { id: row!.id, importId: row!.id };
  },
});

const importItem = z.object({
  id: z.string(),
  entity: z.string().nullable(),
  status: z.string().nullable(),
  rowsTotal: z.number().nullable(),
  rowsOk: z.number().nullable(),
  rowsFailed: z.number().nullable(),
  fileName: z.string().nullable(),
  fileAttachmentId: z.string().nullable(),
  errorsAttachmentId: z.string().nullable(),
  startedByName: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type ImportItem = z.infer<typeof importItem>;

export const importList = defineProcess({
  id: "kernel.import.list",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description: "Lista el historial de importaciones de la empresa, la más reciente primero",
  input: z.object({ entity: z.string().min(1).max(100).optional(), limit: z.number().int().min(1).max(200).default(50) }),
  output: z.array(importItem),
  handler: async (ctx, input) => {
    const rows = await ctx.tx<
      {
        id: string;
        entity: string | null;
        status: string | null;
        rows_total: number | null;
        rows_ok: number | null;
        rows_failed: number | null;
        file_name: string | null;
        file_attachment_id: string | null;
        errors_attachment_id: string | null;
        started_by_name: string | null;
        error: string | null;
        created_at: Date;
        finished_at: Date | null;
      }[]
    >`
      select i.id, i.entity, i.status, i.rows_total, i.rows_ok, i.rows_failed, a.file_name, i.file_attachment_id,
             i.errors_attachment_id, coalesce(u.full_name, u.email) as started_by_name, i.error, i.created_at, i.finished_at
      from kernel.v_imports i
      left join kernel.attachments a on a.id = i.file_attachment_id
      left join kernel.users u on u.id = i.started_by
      where ${input.entity ?? null}::text is null or i.entity = ${input.entity ?? null}
      order by i.created_at desc, i.id desc
      limit ${input.limit}`;
    return rows.map((r) => ({
      id: r.id,
      entity: r.entity,
      status: r.status,
      rowsTotal: r.rows_total,
      rowsOk: r.rows_ok,
      rowsFailed: r.rows_failed,
      fileName: r.file_name,
      fileAttachmentId: r.file_attachment_id,
      errorsAttachmentId: r.errors_attachment_id,
      startedByName: r.started_by_name,
      error: r.error,
      createdAt: r.created_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
    }));
  },
});

export const IMPORT_PROCESSES = [importTemplate, importPreview, importRun, importList];
