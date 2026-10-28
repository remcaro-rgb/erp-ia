import { FatalError } from "workflow";
import { getServiceDb } from "../db/service";
import { exportsStore } from "../files/store";
import { ProcessError } from "../process/errors";
import { QueryError } from "../query/errors";
import { registry } from "../registry";
import { loadExportJob, markExportFailed, recordExport, type ExportJobArgs } from "./jobs";
import { openExport } from "./render";
import type { ExportSpec } from "./plan";

// The export job (design §9): when `kernel.export.run` finds 10,000 rows or more, the route starts this workflow with
// the job it recorded. It marks the job running, renders the file as the caller who asked — the same columns, masking
// and filter as the grid, every page, read 1,000 rows at a time — stores it at `<company>/<job>.<ext>` in the
// bucket `exports`, and records the row count and the final status. A failure is recorded as `failed` with a plain
// message; the cause goes to the log. Status changes are audited on the chain of the export that started the job.

export interface ExportJobOutcome {
  jobId: string;
  status: "done" | "failed";
  rowCount: number;
}

export async function exportJobWorkflow(args: ExportJobArgs): Promise<ExportJobOutcome> {
  "use workflow";

  try {
    await beginExport(args);
    const rowCount = await renderExportJob(args);
    return { jobId: args.jobId, status: "done", rowCount };
  } catch (error) {
    // A step that kept failing after its retries (or one that cannot succeed): the job ends failed, visibly.
    await failExport(args, error instanceof Error ? error.message : String(error));
    return { jobId: args.jobId, status: "failed", rowCount: 0 };
  }
}

/** Marks the job running. A worker without the app's modules cannot resolve the entity: fail the step (it is retried). */
export async function beginExport(args: ExportJobArgs): Promise<void> {
  "use step";
  if (registry.modules().length === 0) throw new Error("export: no modules loaded in worker");
  const sql = getServiceDb();
  const job = await loadExportJob(sql, args.jobId);
  if (!job) throw new FatalError(`export job ${args.jobId} not found`);
  if (job.companyId !== args.claims.active_company_id || job.userId !== args.claims.sub) throw new FatalError(`export job ${args.jobId} is not the caller's`);
  await recordExport(sql, args, { status: "running" });
}

/**
 * Renders the file and stores it. A retried step replaces what an earlier attempt stored. Returns the rows written.
 * A refusal the caller's access would give again (a field now hidden, a role withdrawn) is final.
 */
export async function renderExportJob(args: ExportJobArgs): Promise<number> {
  "use step";
  const sql = getServiceDb();
  const job = await loadExportJob(sql, args.jobId);
  if (!job) throw new FatalError(`export job ${args.jobId} not found`);
  const spec: ExportSpec = { entity: job.entity, format: job.format, ...job.state, state: job.state.state as ExportSpec["state"] };
  try {
    const rendered = await openExport(sql, registry, args.claims, spec);
    const path = `${job.companyId}/${job.id}.${job.format}`;
    const store = await exportsStore();
    await store.remove(path).catch(() => undefined);
    await store.put(path, rendered.body, rendered.contentType);
    await recordExport(sql, args, { status: "done", storage_path: path, file_name: rendered.fileName, row_count: rendered.rowCount(), finished_at: new Date() });
    return rendered.rowCount();
  } catch (error) {
    console.error(`export job ${args.jobId} failed`, error);
    if (error instanceof QueryError || error instanceof ProcessError) throw new FatalError(error.message);
    throw error;
  }
}

/** Records the job as failed, with the plain message (the cause was logged by the step). */
export async function failExport(args: ExportJobArgs, reason: string): Promise<void> {
  "use step";
  console.error(`export job ${args.jobId} ended failed: ${reason}`);
  await markExportFailed(getServiceDb(), args);
}
