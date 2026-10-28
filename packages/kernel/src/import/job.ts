import type { Sql } from "postgres";
import { setAuditContext, writeAudit } from "../audit/audit";
import type { JwtClaims } from "../db/client";
import { fileStore } from "../files/store";
import { registry } from "../registry";
import { importColumns, importTarget, type ImportColumn } from "./columns";
import { mapSheet, type ImportLabels, type MappedSheet } from "./map";
import { ImportFileError, parseImportFile } from "./parse";

// The server-side state of one import, shared by the submit helper and the workflow steps: the record's source
// file read back and mapped, the final status and the summary audit entry. Status and counts are written with the
// service connection (the workflow's), under the import's audit context so the row trigger records origin, process
// and chain.

/** Tags of the import record's attachments. */
export const SOURCE_TAG = "Archivo original";
export const ERRORS_TAG = "Errores";
export const ERRORS_FILE_NAME = "errores.csv";
/** Process the import's status changes are audited under. */
const RUN_PROCESS = "kernel.import.run";

export interface ImportJob {
  importId: string;
  entity: string;
  /** The entity's unique key fields, for the in-file duplicates. */
  importKey?: string[];
  fileName: string;
  createProcess: string;
  columns: ImportColumn[];
  sheet: MappedSheet;
}

export interface ImportSummary {
  importId: string;
  status: "done" | "failed";
  total: number;
  created: number;
  rejected: number;
  /** "3 creadas · 1 rechazada", or the reason the whole import failed. */
  summary: string;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 creadas · 1 rechazada". */
export const importSummaryText = (created: number, rejected: number) => `${plural(created, "creada", "creadas")} · ${plural(rejected, "rechazada", "rechazadas")}`;

// Parsed files by import id, so the steps of one run in one process read and map the file once.
const CACHE_KEY = Symbol.for("erp.kernel.importJobs");
const cacheGlobals = globalThis as { [CACHE_KEY]?: Map<string, Promise<ImportJob>> };
const cache = (cacheGlobals[CACHE_KEY] ??= new Map<string, Promise<ImportJob>>());

/** The import's source attachment, or null when none was attached. */
export async function sourceOf(sql: Sql, importId: string) {
  const [row] = await sql<{ entity: string; attachment_id: string | null; storage_path: string | null; file_name: string | null }[]>`
    select i.entity, a.id as attachment_id, a.storage_path, a.file_name
    from kernel.imports i
    left join kernel.attachments a
      on a.entity = 'kernel.import' and a.record_id = i.id and a.tag = ${SOURCE_TAG} and a.removed_at is null
    where i.id = ${importId}
    order by a.created_at
    limit 1`;
  return row ?? null;
}

/** Reads the import's source file and maps it to the target's columns (cached per import in this process). Throws `ImportFileError`. */
export function loadJob(sql: Sql, importId: string, labels: ImportLabels = {}): Promise<ImportJob> {
  let job = cache.get(importId);
  if (!job) {
    job = (async () => {
      const source = await sourceOf(sql, importId);
      if (!source) throw new Error(`import ${importId} not found`);
      if (!source.storage_path || !source.file_name) throw new ImportFileError("La importación no tiene el archivo original");
      const bytes = await (await fileStore()).get(source.storage_path);
      const parsed = await parseImportFile(bytes, source.file_name);
      const { entity, createProcess } = importTarget(registry, source.entity);
      const columns = importColumns(registry, source.entity);
      return { importId, entity: source.entity, importKey: entity.importKey, fileName: source.file_name, createProcess: createProcess.id, columns, sheet: mapSheet(columns, parsed, labels) };
    })();
    cache.set(importId, job);
    // A failed read is not kept: a retried step reads again.
    job.catch(() => cache.delete(importId));
  }
  return job;
}

export const forgetJob = (importId: string) => void cache.delete(importId);

export interface ImportCounts {
  total: number;
  created: number;
  rejected: number;
}

/**
 * Writes the import row's change (and its audit entry) in one service transaction, under the import's chain; returns
 * the counts the row holds afterwards.
 */
export async function recordImport(
  sql: Sql,
  args: { importId: string; claims: JwtClaims; chainId: string },
  change: Record<string, unknown>,
  audit?: Record<string, unknown>,
): Promise<ImportCounts> {
  return sql.begin(async (tx) => {
    await setAuditContext(tx, { origin: "api", processId: RUN_PROCESS, chainId: args.chainId, actorUserId: args.claims.sub });
    const [row] = await tx<{ rows_total: number; rows_ok: number; rows_failed: number }[]>`
      update kernel.imports set ${tx(change)} where id = ${args.importId} returning rows_total, rows_ok, rows_failed`;
    if (audit) {
      await writeAudit(tx, {
        companyId: args.claims.active_company_id,
        actorUserId: args.claims.sub,
        origin: "api",
        processId: RUN_PROCESS,
        entity: "kernel.import",
        rowId: args.importId,
        action: "update",
        input: audit,
        chainId: args.chainId,
      });
    }
    return { total: row?.rows_total ?? 0, created: row?.rows_ok ?? 0, rejected: row?.rows_failed ?? 0 };
  }) as Promise<ImportCounts>;
}

/**
 * Marks the import failed as a whole with `reason` (a user message, or a `row_<code>` the UI translates), audited.
 * The counts recorded so far stay: rows already created are not undone.
 */
export async function failImport(sql: Sql, args: { importId: string; claims: JwtClaims; chainId: string }, reason: string): Promise<ImportSummary> {
  forgetJob(args.importId);
  const counts = await recordImport(sql, args, { status: "failed", error: reason, finished_at: new Date() }, { summary: `fallida: ${reason}` });
  return { importId: args.importId, status: "failed", ...counts, summary: reason };
}
