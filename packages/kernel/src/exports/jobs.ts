import type { Sql } from "postgres";
import { setAuditContext } from "../audit/audit";
import { withClaims, type JwtClaims } from "../db/client";
import { exportsStore } from "../files/store";
import type { ExportFormat } from "./types";

// The export job record (migration 0016): its status and counts are written by the workflow with the service
// connection, under the job's audit context so the row trigger records origin, process and chain; it is read by its
// owner through the masked view `kernel.v_export_jobs`, which only shows a member their own jobs.

/** Process the job's changes are audited under. */
const RUN_PROCESS = "kernel.export.run";
/** A download link lives this long (design §9). */
export const EXPORT_URL_TTL_SECONDS = 600;
/** The only thing a user is told when a job fails: the cause is logged, not shown. */
export const EXPORT_FAILED_MESSAGE = "No se pudo generar la exportación";

export interface ExportJobArgs {
  jobId: string;
  /** The claims of the caller who started the export: the job reads as them. */
  claims: JwtClaims;
  /** The chain of the `kernel.export.run` call. */
  chainId: string;
}

/** The job as the workflow reads it (service role): what it was asked for. */
export interface ExportJobRow {
  id: string;
  companyId: string;
  userId: string;
  entity: string;
  format: ExportFormat;
  status: string;
  state: { state: unknown; source?: { kind: "report"; id: string; params: unknown }; title?: string; labels?: Record<string, string>; values?: Record<string, Record<string, string>>; locale?: string };
}

export async function loadExportJob(sql: Sql, jobId: string): Promise<ExportJobRow | null> {
  const [row] = await sql<{ id: string; company_id: string; user_id: string; entity: string; format: ExportFormat; status: string; state: ExportJobRow["state"] }[]>`
    select id, company_id, user_id, entity, format, status, state from kernel.export_jobs where id = ${jobId}`;
  return row ? { id: row.id, companyId: row.company_id, userId: row.user_id, entity: row.entity, format: row.format, status: row.status, state: row.state } : null;
}

/**
 * Writes the job's change in one service transaction, on the job's chain. The row trigger writes the audit entry (one per
 * change, origin `api`, process `kernel.export.run`); the user the job belongs to is recorded as the one who updated it.
 */
export async function recordExport(sql: Sql, args: ExportJobArgs, change: Record<string, unknown>): Promise<void> {
  await sql.begin(async (tx) => {
    await setAuditContext(tx, { origin: "api", processId: RUN_PROCESS, chainId: args.chainId, actorUserId: args.claims.sub });
    // `kernel.touch_updated` stamps `updated_by` from the request claims, which a service connection has none of.
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: args.claims.sub })}, true)`;
    await tx`update kernel.export_jobs set ${tx(change)} where id = ${args.jobId}`;
  });
}

/** Records the job as failed with the plain message (the cause is the caller's to log). */
export async function markExportFailed(sql: Sql, args: ExportJobArgs): Promise<void> {
  await recordExport(sql, args, { status: "failed", error: EXPORT_FAILED_MESSAGE, finished_at: new Date() });
}

export interface ExportJobStatus {
  status: "queued" | "running" | "done" | "failed";
  rowCount: number | null;
  fileName: string | null;
  error: string | null;
  /** A 10-minute download link, once the job is done. */
  url?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The job's status for the caller, or null when it is not theirs (or does not exist): the read goes through
 * `kernel.v_export_jobs` under their claims, so a job started by someone else is not there to find, whatever the id.
 * A finished job carries a download link signed by the exports store.
 */
export async function exportJobStatus(sql: Sql, claims: JwtClaims, jobId: string): Promise<ExportJobStatus | null> {
  if (!UUID.test(jobId)) return null;
  const [row] = await withClaims(
    sql,
    claims,
    (tx) => tx<{ status: ExportJobStatus["status"]; row_count: number | null; file_name: string | null; error: string | null; storage_path: string | null }[]>`
      select status, row_count, file_name, error, storage_path from kernel.v_export_jobs where id = ${jobId}`,
  );
  if (!row) return null;
  const status: ExportJobStatus = { status: row.status, rowCount: row.row_count, fileName: row.file_name, error: row.error };
  if (row.status === "done" && row.storage_path) {
    status.url = await (await exportsStore()).signedUrl(row.storage_path, EXPORT_URL_TTL_SECONDS, row.file_name ?? undefined);
  }
  return status;
}
