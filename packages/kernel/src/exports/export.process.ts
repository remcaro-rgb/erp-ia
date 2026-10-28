import type { JSONValue } from "postgres";
import { z } from "zod";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { gridEntity } from "../query/access";
import { QueryError } from "../query/errors";
import { GridState } from "../query/grid-state";
import { CONTENT_TYPE, exportFileName } from "./file";
import { planExport, type ExportSpec } from "./plan";
import { EXPORT_FORMATS, EXPORT_INLINE_LIMIT, EXPORT_PDF_INLINE_LIMIT, EXPORT_PDF_MAX_ROWS } from "./types";

// `kernel.export.run` (design §9, rule 20): the consult process behind the PDF / Excel / CSV buttons of every grid.
// It checks what the grid checks (`planExport`: the company is entitled to the entity, a role of the caller may
// consult it, no hidden or masked field is filtered or sorted), counts the rows of the filter and answers how the file is made:
// `inline` (the route renders it in the request) or `job` (a durable workflow renders it into storage). It is audited
// as a consult of the caller. The file itself is rendered by `openExport` (render.ts), which reads the same columns.

export const FEATURE = "kernel.exports";

const MAX_LABELS = 300;
const MAX_OPTIONS = 5000;

const exportInput = z.object({
  entity: z.string().min(1).max(100),
  format: z.enum(EXPORT_FORMATS),
  /** The grid's state: its filters, sort and columns apply; the page does not (every page is exported). */
  state: GridState,
  title: z.string().trim().min(1).max(120).optional(),
  /** Header by field, as the user's screen shows it. */
  labels: z.record(z.string().max(80), z.string().max(200)).refine((r) => Object.keys(r).length <= MAX_LABELS, "demasiadas etiquetas").optional(),
  /** Value labels by field. */
  values: z
    .record(z.string().max(80), z.record(z.string().max(200), z.string().max(200)))
    .refine((r) => Object.keys(r).length <= MAX_LABELS && Object.values(r).reduce((n, o) => n + Object.keys(o).length, 0) <= MAX_OPTIONS, "demasiados valores")
    .optional(),
});
export type ExportInput = z.infer<typeof exportInput>;

/** What a client asks for; the labels are added by the server from the caller's language. */
export const exportRequest = exportInput.pick({ entity: true, format: true, state: true, title: true });

const exportOutput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), filename: z.string(), contentType: z.string() }),
  z.object({ mode: z.literal("job"), jobId: z.string() }),
]);
export type ExportOutput = z.infer<typeof exportOutput>;

/** A grid state the grid would refuse is refused the same way: a hidden or masked field is a denial, the rest a bad request. */
const asProcessError = (error: unknown): unknown =>
  error instanceof QueryError
    ? new ProcessError(error.code === "field_hidden" ? "forbidden" : "invalid_input", error.message, { details: [error.field] })
    : error;

export const exportRun = defineProcess({
  id: "kernel.export.run",
  module: "kernel",
  kind: "consult",
  feature: FEATURE,
  description:
    "Exporta a PDF, Excel o CSV lo que muestra un grid (filtros, orden y columnas visibles, todas las páginas); desde 10.000 filas se genera en segundo plano",
  input: exportInput,
  output: exportOutput,
  // The audit row says what was exported (entity, format, state), not the screen's headers and value lists.
  auditInput: (input) => ({ entity: input.entity, format: input.format, state: input.state, title: input.title }),
  handler: async (ctx, input): Promise<ExportOutput> => {
    const entity = gridEntity(ctx.registry, input.entity);
    if (!entity) throw new ProcessError("invalid_input", `unknown entity ${input.entity}`, { details: [`La entidad ${input.entity} no existe`] });

    const spec: ExportSpec = input;
    const plan = await planExport(ctx.tx, ctx.registry, spec).catch((error) => {
      throw asProcessError(error);
    });
    if (input.format === "pdf" && plan.total > EXPORT_PDF_MAX_ROWS) {
      throw new ProcessError("invalid_input", `a PDF takes up to ${EXPORT_PDF_MAX_ROWS} rows, this export has ${plan.total}`, { details: ["pdf_too_large"] });
    }
    const filename = exportFileName(input.title, input.entity, input.format, plan.access.timeZone);
    // A PDF is laid out in memory: a request renders up to 2,000 rows, a job up to 10,000 (CSV and Excel stream).
    const inlineLimit = input.format === "pdf" ? EXPORT_PDF_INLINE_LIMIT + 1 : EXPORT_INLINE_LIMIT;
    if (plan.total < inlineLimit) return { mode: "inline", filename, contentType: CONTENT_TYPE[input.format] };

    // Too many rows for a request: a job the workflow renders into storage as this caller. The rows' status and
    // counts are kept by the workflow (service role); the grid state it was asked for is kept with the job.
    const request = { state: input.state, title: input.title, labels: input.labels, values: input.values };
    const [job] = await ctx.tx<{ id: string }[]>`
      insert into kernel.export_jobs (company_id, user_id, entity, format, state, file_name)
      values (${ctx.companyId}, ${ctx.userId}, ${input.entity}, ${input.format}, ${ctx.tx.json({ ...request, locale: ctx.locale } as unknown as JSONValue)}, ${filename})
      returning id`;
    return { mode: "job", jobId: job!.id };
  },
});

export const EXPORT_PROCESSES = [exportRun];
