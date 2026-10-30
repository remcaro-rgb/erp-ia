import { randomUUID } from "node:crypto";
import { start } from "workflow/api";
import { reportOf, runProcess } from "@erp/kernel";
import { exportJobWorkflow, exportRequest, markExportFailed, openExport, openReportExport, type ExportOutput, type ExportSpec } from "@erp/kernel/exports";
import { callerOrResponse } from "@/lib/auth/http";
import { exportPresentation, translator } from "@/lib/exports/presentation";
import { gridEntity } from "@/lib/grid/access";
import { processFailure } from "@/lib/server/process-response";
import { processDeps } from "@/lib/server/runtime";

// POST /api/export  body { entity, format: csv|xlsx|pdf, state: GridState, title?, source?: { kind: "report", id, params } }   (design §9, rules 14 and 20)
// Exports what a grid shows, as the session's user: kernel.export.run checks the grid's own access (entitlement, the
// entity's consult permission, no hidden or masked field in the filter or sort), counts the rows and says how the file
// is made. Under 10,000 rows the file comes back in this response; from there on a job is recorded, the workflow
// starts and the answer is 202 { mode: "job", jobId } — poll GET /api/export/:jobId for the link. The columns are
// exactly the ones the caller sees, in the state's order, all pages; masked values print ••••••. Refusals as the
// grid's: 401 without a session, 403 (not entitled, no permission, hidden field, a foreign x-company-id), 404 for an
// unknown entity, 400 for a bad body.

/** A grid state is a few hundred bytes; anything this large is not one. */
const MAX_BODY_BYTES = 256 * 1024;

const problem = (status: number, code: string, details: unknown = null) => Response.json({ code, details }, { status });

export async function POST(httpRequest: Request): Promise<Response> {
  const caller = await callerOrResponse();
  if (caller instanceof Response) return caller;
  const { claims } = caller;

  const company = httpRequest.headers.get("x-company-id");
  if (company !== null && company !== claims.active_company_id) return problem(403, "forbidden", ["x-company-id is not the active company of the session"]);
  const declared = Number(httpRequest.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return problem(413, "invalid_input", ["body too large"]);
  const parsed = exportRequest.safeParse(await httpRequest.json().catch(() => null));
  if (!parsed.success) return problem(400, "invalid_input", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));

  const deps = processDeps();
  const report = parsed.data.source ? reportOf(deps, parsed.data.source.id) : null;
  if (parsed.data.source && !report) return problem(404, "not_found");
  const entity = report ? null : gridEntity(deps.registry, parsed.data.entity);
  if (!report && !entity) return problem(404, "not_found");

  try {
    // A report's headers are its columns' labels in the caller's language; a grid's are the screen's.
    const translate = translator(claims.locale);
    const presentation = report
      ? { labels: Object.fromEntries(report.columns.map((c) => [c.field, translate(c.label)])), values: {} }
      : await exportPresentation(deps, caller, entity!, parsed.data.state.columns);
    const spec: ExportSpec = { ...parsed.data, ...presentation };
    // One chain for the export: the consult, the job's status changes and the workflow's work join it.
    const chainId = randomUUID();
    const result = (await runProcess(deps, { ...caller, chainId }, "kernel.export.run", spec)) as ExportOutput;

    if (result.mode === "job") {
      const args = { jobId: result.jobId, claims, chainId };
      try {
        // The job is committed: the workflow reads it by id.
        await start(exportJobWorkflow, [args]);
      } catch (error) {
        await markExportFailed(deps.sql, args);
        throw error;
      }
      return Response.json({ mode: "job", jobId: result.jobId }, { status: 202 });
    }

    const file = report
      ? await openReportExport(deps, { ...caller, chainId }, { id: report.id, params: parsed.data.source!.params, format: spec.format, title: spec.title ?? (report.pdfTitle ? translate(report.pdfTitle) : undefined), labels: presentation.labels, values: presentation.values })
      : await openExport(deps.sql, deps.registry, claims, spec);
    return new Response(file.body instanceof ReadableStream ? file.body : new Uint8Array(file.body), {
      headers: {
        "Content-Type": file.contentType,
        "Content-Disposition": `attachment; filename="${file.fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return processFailure(error);
  }
}
