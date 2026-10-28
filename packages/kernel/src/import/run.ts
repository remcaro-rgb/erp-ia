import { randomUUID } from "node:crypto";
import { getServiceDb } from "../db/service";
import type { JwtClaims } from "../db/client";
import { fileStore } from "../files/store";
import type { Caller } from "../process/context";
import { runProcess } from "../process/run";
import { registry } from "../registry";
import { errorsCsv } from "./errors-csv";
import { ERRORS_FILE_NAME, ERRORS_TAG, failImport, forgetJob, importSummaryText, loadJob, recordImport, sourceOf, type ImportSummary } from "./job";
import { inFileDuplicates, type ImportLabels } from "./map";
import { ImportFileError } from "./parse";
import { resolveReferences, runRecords } from "./validate";

// The import workflow (design §5.11 "validate → commit → report", §9). Started by the route once
// `kernel.import.run` committed the import record and its source file was attached. It reads the file, validates
// every row with the entity's create process in a dry run, creates the valid rows for real in batches of 500 (one
// step each, in file order, so a document repeated in the file is refused on its second occurrence by the process's
// own uniqueness), writes errores.csv when a row was refused, and records the counts with the final audit entry
// ("3 creadas · 1 rechazada"). Every process runs as the caller who imported, origin `api`, on one chain. The counts
// are recorded after every batch; a denial of the caller (step-up, permission) stops the import at its first row.

export interface RunImportArgs {
  importId: string;
  claims: JwtClaims;
  /** The chain of the `kernel.import.run` call: every row, file and audit entry of the import joins it. */
  chainId: string;
  /** Column key → header label, to read a file whose headers are the template's labels. */
  labels?: ImportLabels;
}

/** Rows per validation step and per creation step. */
export const IMPORT_BATCH = 500;

interface Failure {
  index: number;
  errors: string[];
}

export async function runImport(args: RunImportArgs): Promise<ImportSummary> {
  "use workflow";

  try {
    const begun = await beginImport(args);
    if (!begun.ok) return await abandonImport(args, begun.reason);

    const failed: Failure[] = [];
    const valid: number[] = [];
    for (let from = 0; from < begun.total; from += IMPORT_BATCH) {
      const batch = await validateBatch(args, from, failed.length);
      if (batch.stoppedBy) return await abandonImport(args, `row_${batch.stoppedBy}`);
      valid.push(...batch.valid);
      failed.push(...batch.failed);
    }
    // In-file duplicates are judged among the valid rows of the whole file, before anything is created.
    const screened = await screenDuplicates(args, valid, failed.length);
    failed.push(...screened.failed);
    valid.splice(0, valid.length, ...screened.valid);
    let created = 0;
    for (let at = 0; at < valid.length; at += IMPORT_BATCH) {
      const batch = await createBatch(args, valid.slice(at, at + IMPORT_BATCH), { created, failed: failed.length });
      created += batch.created;
      failed.push(...batch.failed);
      if (batch.stoppedBy) return await abandonImport(args, `row_${batch.stoppedBy}`);
    }
    return await finishImport(args, { total: begun.total, created, failed });
  } catch (error) {
    // A step that kept failing after its retries: the import stops, recorded as failed with the counts it reached
    // (rows already created stay).
    return await abandonImport(args, error instanceof Error ? error.message : String(error));
  }
}

const callerOf = (args: RunImportArgs): Caller => ({ claims: args.claims, origin: "api", chainId: args.chainId });
const deps = () => ({ sql: getServiceDb(), registry });

/** The idempotency key of a row's creation: a retried batch replays the rows it already created. */
export const importRowKey = (importId: string, index: number) => `import:${importId}:${index}`;

/** Reads and maps the file, marks the import running with its row count; a file that cannot be read ends it. */
export async function beginImport(args: RunImportArgs): Promise<{ ok: true; total: number } | { ok: false; reason: string }> {
  "use step";
  // A worker without the app's modules cannot resolve the entity: fail the step (it is retried) rather than the import.
  if (registry.modules().length === 0) throw new Error("import: no modules loaded in worker");
  const sql = getServiceDb();
  try {
    const job = await loadJob(sql, args.importId, args.labels);
    const source = await sourceOf(sql, args.importId);
    await recordImport(sql, args, { status: "running", rows_total: job.sheet.records.length, file_attachment_id: source?.attachment_id ?? null });
    return { ok: true, total: job.sheet.records.length };
  } catch (error) {
    if (error instanceof ImportFileError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Dry-runs rows `from`..`from + IMPORT_BATCH` of the file: which are valid, and why the others are not. Records the
 * refused rows so far (`failedBefore` plus this batch's) on the import, so the counts survive a later failure.
 */
export async function validateBatch(args: RunImportArgs, from: number, failedBefore: number): Promise<{ valid: number[]; failed: Failure[]; stoppedBy?: string }> {
  "use step";
  const sql = getServiceDb();
  const job = await loadJob(sql, args.importId, args.labels);
  const slice = job.sheet.records.slice(from, from + IMPORT_BATCH).map((record, i) => ({ index: from + i, record }));
  await resolveReferences(deps(), callerOf(args), job.columns, slice.map((s) => s.record), args.labels);
  const run = await runRecords(deps(), callerOf(args), job.createProcess, job.columns, slice, { dryRun: true, labels: args.labels });
  const failed = run.outcomes.filter((o) => !o.ok).map((o) => ({ index: o.index, errors: o.errors }));
  await recordImport(sql, args, { rows_failed: failedBefore + failed.length });
  return { valid: run.outcomes.filter((o) => o.ok).map((o) => o.index), failed, ...(run.stoppedBy ? { stoppedBy: run.stoppedBy } : {}) };
}

/**
 * Refuses the valid rows that repeat an earlier valid row of the file on the entity's unique key (in file order), so
 * the second occurrence never reaches the create process. Records the refused rows so far on the import.
 */
export async function screenDuplicates(args: RunImportArgs, valid: number[], failedBefore: number): Promise<{ valid: number[]; failed: Failure[] }> {
  "use step";
  const sql = getServiceDb();
  const job = await loadJob(sql, args.importId, args.labels);
  const duplicates = inFileDuplicates(job.columns, valid.map((index) => ({ index, record: job.sheet.records[index]! })), job.importKey, args.labels);
  if (duplicates.size === 0) return { valid, failed: [] };
  const failed = [...duplicates].map(([index, error]) => ({ index, errors: [error] }));
  await recordImport(sql, args, { rows_failed: failedBefore + failed.length });
  return { valid: valid.filter((index) => !duplicates.has(index)), failed };
}

/**
 * Creates the valid rows at `indexes` for real, in order, each keyed `import:<id>:<row index>` so a retry of this step
 * replays the rows it already created. A row the process refuses now (a duplicate) is a failure. Records the counts
 * so far (`before` plus this batch) on the import.
 */
export async function createBatch(
  args: RunImportArgs,
  indexes: number[],
  before: { created: number; failed: number },
): Promise<{ created: number; failed: Failure[]; stoppedBy?: string }> {
  "use step";
  const sql = getServiceDb();
  const job = await loadJob(sql, args.importId, args.labels);
  const slice = indexes.map((index) => ({ index, record: job.sheet.records[index]! }));
  await resolveReferences(deps(), callerOf(args), job.columns, slice.map((s) => s.record), args.labels);
  const run = await runRecords(deps(), callerOf(args), job.createProcess, job.columns, slice, {
    dryRun: false,
    labels: args.labels,
    keyOf: (index) => importRowKey(args.importId, index),
  });
  const created = run.outcomes.filter((o) => o.ok).length;
  const failed = run.outcomes.filter((o) => !o.ok).map((o) => ({ index: o.index, errors: o.errors }));
  await recordImport(sql, args, { rows_ok: before.created + created, rows_failed: before.failed + failed.length });
  return { created, failed, ...(run.stoppedBy ? { stoppedBy: run.stoppedBy } : {}) };
}

/**
 * Attaches errores.csv when a row was refused (once: a retried step reuses the stored file), then records the
 * counts, the status `done` and the summary audit entry.
 */
export async function finishImport(args: RunImportArgs, result: { total: number; created: number; failed: Failure[] }): Promise<ImportSummary> {
  "use step";
  const sql = getServiceDb();
  const job = await loadJob(sql, args.importId, args.labels);
  const failed = [...result.failed].sort((a, b) => a.index - b.index);
  let errorsAttachmentId: string | null = null;
  let attachError: string | null = null;
  if (failed.length > 0) {
    try {
      errorsAttachmentId = await attachErrors(args, errorsCsv(job.sheet.headers, failed.map((f) => ({ rowNo: job.sheet.records[f.index]!.rowNo, errors: f.errors, raw: job.sheet.records[f.index]!.raw }))));
    } catch (error) {
      attachError = `No se pudo guardar ${ERRORS_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const summary = importSummaryText(result.created, failed.length);
  await recordImport(
    sql,
    args,
    { status: "done", rows_total: result.total, rows_ok: result.created, rows_failed: failed.length, errors_attachment_id: errorsAttachmentId, error: attachError, finished_at: new Date() },
    { summary, entity: job.entity, file: job.fileName, created: result.created, rejected: failed.length },
  );
  forgetJob(args.importId);
  return { importId: args.importId, status: "done", total: result.total, created: result.created, rejected: failed.length, summary };
}

/** Stores errores.csv and attaches it to the import record as the caller; returns the attachment id. */
async function attachErrors(args: RunImportArgs, bytes: Uint8Array): Promise<string> {
  const sql = getServiceDb();
  const [existing] = await sql<{ id: string }[]>`
    select id from kernel.attachments
    where entity = 'kernel.import' and record_id = ${args.importId} and tag = ${ERRORS_TAG} and removed_at is null`;
  if (existing) return existing.id;
  const { tenant_id: tenantId, active_company_id: companyId } = args.claims;
  const storagePath = `${tenantId}/${companyId}/kernel.import/${args.importId}/${randomUUID()}-${ERRORS_FILE_NAME}`;
  const store = await fileStore();
  await store.put(storagePath, Buffer.from(bytes), "text/csv");
  try {
    const attachment = await runProcess(deps(), callerOf(args), "kernel.attachment.add", {
      entity: "kernel.import",
      recordId: args.importId,
      tag: ERRORS_TAG,
      fileName: ERRORS_FILE_NAME,
      mimeType: "text/csv",
      sizeBytes: bytes.byteLength,
      storagePath,
    });
    return attachment.id as string;
  } catch (error) {
    await store.remove(storagePath).catch(() => undefined);
    throw error;
  }
}

/** Records the import as failed as a whole, keeping the counts it reached. */
export async function abandonImport(args: RunImportArgs, reason: string): Promise<ImportSummary> {
  "use step";
  return failImport(getServiceDb(), args, reason);
}
