import type { JSONValue } from "postgres";
import { z } from "zod";
import { defineProcess } from "../process/define";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import { gridEntity } from "../query/access";
import { QueryError } from "../query/errors";
import { GridState } from "../query/grid-state";
import { CONTENT_TYPE, exportFileName } from "./file";
import { entitled } from "../entitlements/resolver";
import { getServiceDb } from "../db/service";
import { ReportState } from "../reports/state";
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

/** Header by field, as the user's screen shows it (cosmetic; also the PDF templates' labels). */
export const presentationLabels = z.record(z.string().max(80), z.string().max(200)).refine((r) => Object.keys(r).length <= MAX_LABELS, "demasiadas etiquetas");
/** Value labels by field. */
export const presentationValues = z
  .record(z.string().max(80), z.record(z.string().max(200), z.string().max(200)))
  .refine((r) => Object.keys(r).length <= MAX_LABELS && Object.values(r).reduce((n, o) => n + Object.keys(o).length, 0) <= MAX_OPTIONS, "demasiados valores");

const exportInput = z.object({
  /** The grid's entity; ignored (and recorded as `report:<id>`) when `source` names a report. */
  entity: z.string().min(1).max(100),
  /** A report to export instead of an entity's grid: its consult is read in windows, as the caller. */
  source: z.object({ kind: z.literal("report"), id: z.string().min(1).max(100), params: z.unknown() }).optional(),
  format: z.enum(EXPORT_FORMATS),
  /** The grid's state: its filters, sort and columns apply; the page does not (every page is exported). */
  state: GridState,
  title: z.string().trim().min(1).max(120).optional(),
  /** Header by field, as the user's screen shows it. */
  labels: presentationLabels.optional(),
  /** Value labels by field. */
  values: presentationValues.optional(),
});
export type ExportInput = z.infer<typeof exportInput>;

/** What a client asks for; the labels are added by the server from the caller's language. */
export const exportRequest = exportInput.pick({ entity: true, source: true, format: true, state: true, title: true });

const exportOutput = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("inline"), filename: z.string(), contentType: z.string() }),
  z.object({ mode: z.literal("job"), jobId: z.string() }),
]);
export type ExportOutput = z.infer<typeof exportOutput>;

/** A grid state the grid would refuse is refused the same way: a hidden or masked field is a denial, the rest a bad request. */
export const asProcessError = (error: unknown): unknown =>
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
  auditInput: (input) => ({ entity: input.entity, source: input.source, format: input.format, state: input.state, title: input.title }),
  handler: async (ctx, input): Promise<ExportOutput> => {
    if (input.source) {
      // A report: the gate is the report's own (feature entitlement and a role allowed its consult); the rows are
      // counted by running the consult for one row in this transaction, as the caller.
      const def = ctx.registry.reports().find((r) => r.id === input.source!.id);
      if (!def) throw new ProcessError("invalid_input", `unknown report ${input.source.id}`, { details: [`El informe ${input.source.id} no existe`] });
      if (!(await entitled(getServiceDb(), ctx.companyId, `feature:${def.feature}`))) throw new ProcessError("not_entitled", `${def.id} is not entitled for company ${ctx.companyId}`);
      const [row] = await ctx.tx<{ allowed: boolean }[]>`select kernel.can_run_process(${def.consult}) as allowed`;
      if (!row?.allowed) throw new ProcessError("forbidden", `no role of the caller may consult ${def.id}`);
      const params = def.params.safeParse(input.source.params ?? {});
      if (!params.success) throw new ProcessError("invalid_input", `invalid parameters for report ${def.id}`, { details: params.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
      const consult = ctx.registry.process(def.consult);
      const state = ReportState.parse({ ...input.state, page: 1, pageSize: 1 });
      const counted = consult.output.parse(await consult.handler(ctx, consult.input.parse({ params: params.data, state }))) as { total: number };
      const [company] = await ctx.tx<{ timezone: string }[]>`select timezone from kernel.companies where id = ${ctx.companyId}`;
      return deliver(ctx, input, `report:${def.id}`, counted.total, company?.timezone ?? "America/Bogota");
    }
    const entity = gridEntity(ctx.registry, input.entity);
    if (!entity) throw new ProcessError("invalid_input", `unknown entity ${input.entity}`, { details: [`La entidad ${input.entity} no existe`] });

    const spec: ExportSpec = input;
    const plan = await planExport(ctx.tx, ctx.registry, spec, ctx.locale).catch((error) => {
      throw asProcessError(error);
    });
    return deliver(ctx, input, input.entity, plan.total, plan.access.timeZone);
  },
});

/** How the file is made for `total` rows: `inline` in the request, or a `job` the workflow renders into storage. */
async function deliver(ctx: ProcessContext, input: ExportInput, entity: string, total: number, timeZone: string): Promise<ExportOutput> {
  if (input.format === "pdf" && total > EXPORT_PDF_MAX_ROWS) {
    throw new ProcessError("invalid_input", `a PDF takes up to ${EXPORT_PDF_MAX_ROWS} rows, this export has ${total}`, { details: ["pdf_too_large"] });
  }
  const filename = exportFileName(input.title, entity, input.format, timeZone);
  // A PDF is laid out in memory: a request renders up to 2,000 rows, a job up to 10,000 (CSV and Excel stream).
  const inlineLimit = input.format === "pdf" ? EXPORT_PDF_INLINE_LIMIT + 1 : EXPORT_INLINE_LIMIT;
  if (total < inlineLimit) return { mode: "inline", filename, contentType: CONTENT_TYPE[input.format] };

  // Too many rows for a request: a job the workflow renders into storage as this caller. The rows' status and
  // counts are kept by the workflow (service role); what it was asked for (grid state, or the report) is kept with the job.
  const request = { state: input.state, source: input.source, title: input.title, labels: input.labels, values: input.values };
  const [job] = await ctx.tx<{ id: string }[]>`
    insert into kernel.export_jobs (company_id, user_id, entity, format, state, file_name)
    values (${ctx.companyId}, ${ctx.userId}, ${entity}, ${input.format}, ${ctx.tx.json({ ...request, locale: ctx.locale } as unknown as JSONValue)}, ${filename})
    returning id`;
  return { mode: "job", jobId: job!.id };
}

export const EXPORT_PROCESSES = [exportRun];
