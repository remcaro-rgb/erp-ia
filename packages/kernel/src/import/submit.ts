import { randomUUID } from "node:crypto";
import { fileStore } from "../files/store";
import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { runProcess, type RunProcessDeps } from "../process/run";
import { LINES_LABEL_PREFIX, REF_KEY, type ImportColumn } from "./columns";
import { failImport, SOURCE_TAG } from "./job";
import { columnLabel, inFileDuplicates, lineLabels, type ImportLabels } from "./map";
import { importFormatOf, type ImportFormat } from "./format";
import { ImportFileError } from "./parse";
import { readImport } from "./read";
import { resolveReferences, runRecords } from "./validate";

// What a server entry point (the import route, later the assistant) does with an uploaded file, as the caller.
// `previewImport` checks it without writing anything; `submitImport` creates the import record and attaches the
// file, after which the caller starts the `runImport` workflow with the returned id and chain.

/** An uploaded file. Its type is not taken from the client: it follows from the file's format (`importMimeType`). */
export interface ImportUpload {
  entity: string;
  fileName: string;
  bytes: Uint8Array;
}

/** The stored type of an import file, from its format: the client's declared type is never trusted. */
export const importMimeType = (format: ImportFormat) => (format === "xlsx" ? XLSX_MIME : "text/csv");
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** What a denial of the caller on the rows means for the user (the import cannot create them at all). */
const STOP_DETAILS: Record<string, string> = {
  step_up_required: "Crear estos registros exige verificación en dos pasos en cada uno: la importación no puede crearlos",
  forbidden: "No tienes permiso para crear estos registros",
  not_entitled: "Tu empresa no tiene habilitada la creación de estos registros",
};

/** Rows the preview validates (the import itself validates every row). */
export const PREVIEW_ROWS = 200;

export interface ImportPreview {
  entity: string;
  fileName: string;
  columns: { key: string; label: string; required: boolean }[];
  headers: string[];
  unknownHeaders: string[];
  /** Labels of the required columns the file lacks: every row would be refused. */
  missingColumns: string[];
  /** Data rows in the file. */
  total: number;
  /** The first `PREVIEW_ROWS` rows, validated with the create process in a dry run. */
  rows: { rowNo: number; ok: boolean; errors: string[]; cells: string[] }[];
  /** A documento's lines refused on their own (their ref names no header row), by their Líneas row (D14). */
  lineErrors: { rowNo: number; errors: string[] }[];
}

/** Storage keys avoid accents and spaces; the original name stays in the attachment row. */
const storageName = (fileName: string) => fileName.normalize("NFKD").replace(/[^\w.-]+/g, "_");

const fileRefusal = (error: ImportFileError) => new ProcessError("invalid_input", "the import file cannot be read", { details: [error.message] });

/**
 * Checks an upload as the caller without writing: `kernel.import.preview` (permission and audit), then the file's
 * header against the entity's columns and its first rows against the create process in a dry run.
 */
export async function previewImport(deps: RunProcessDeps, caller: Caller, upload: ImportUpload, labels: ImportLabels = {}): Promise<ImportPreview> {
  const { columns, createProcess } = (await runProcess(deps, caller, "kernel.import.preview", {
    entity: upload.entity,
    fileName: upload.fileName,
    sizeBytes: upload.bytes.byteLength,
  })) as { columns: ImportColumn[]; createProcess: string };
  let read;
  try {
    read = await readImport(deps.registry, upload.entity, upload.bytes, upload.fileName, labels, caller.claims.locale);
  } catch (error) {
    if (error instanceof ImportFileError) throw fileRefusal(error);
    throw error;
  }
  const { sheet: mapped, lines } = read;
  const shown = mapped.records.slice(0, PREVIEW_ROWS);
  await resolveReferences(deps, caller, columns, shown, labels, lines);
  const target = { entity: deps.registry.entity(upload.entity), lines };
  const run = await runRecords(deps, caller, createProcess, columns, shown.map((record, index) => ({ index, record })), { dryRun: true, labels, target });
  // A denial of the caller on the rows is the same for every row: one refusal for the whole file.
  if (run.stoppedBy) throw new ProcessError("invalid_input", `import rows refused: ${run.stoppedBy}`, { details: [STOP_DETAILS[run.stoppedBy] ?? run.stoppedBy] });
  // Among the valid rows, a repeat of an earlier one is refused as the run refuses it.
  const duplicates = inFileDuplicates(columns, run.outcomes.filter((o) => o.ok).map((o) => ({ index: o.index, record: shown[o.index]! })), deps.registry.entity(upload.entity).importKey, labels);
  const outcomes = run.outcomes.map((o) => (duplicates.has(o.index) ? { ...o, ok: false, errors: [duplicates.get(o.index)!] } : o));
  const byKey = new Map<string, ImportColumn>(columns.map((c) => [c.key, c]));
  const ofLines = lineLabels(labels);
  const lineColumns = (lines?.columns ?? []).filter((c) => c.key !== REF_KEY);
  for (const c of lines?.columns ?? []) byKey.set(`${LINES_LABEL_PREFIX}${c.key}`, c);
  const labelOf = (key: string) => columnLabel(byKey.get(key)!, key.startsWith(LINES_LABEL_PREFIX) ? ofLines : labels);
  return {
    entity: upload.entity,
    fileName: upload.fileName,
    columns: [
      ...columns.map((c) => ({ key: c.key, label: columnLabel(c, labels), required: c.required })),
      ...lineColumns.map((c) => ({ key: `${LINES_LABEL_PREFIX}${c.key}`, label: columnLabel(c, ofLines), required: c.required })),
    ],
    headers: mapped.headers,
    unknownHeaders: mapped.unknownHeaders,
    missingColumns: mapped.missingColumns.map(labelOf),
    total: mapped.records.length,
    rows: outcomes.map((o) => ({ rowNo: o.rowNo, ok: o.ok, errors: o.errors, cells: mapped.headers.map((h) => shown[o.index]!.raw[h] ?? "") })),
    lineErrors: (mapped.lineFailures ?? []).map((l) => ({ rowNo: l.rowNo, errors: l.errors })),
  };
}

/**
 * Starts an import as the caller: runs `kernel.import.run` (step-up, permission, the import record), reads the file
 * (a file that cannot be read is refused before anything is stored), stores it with the type its format implies and
 * attaches it to the record as its source. Returns the import id and the chain to start `runImport` with. When the
 * file is refused or cannot be attached, the import is recorded as failed and the refusal is thrown.
 */
export async function submitImport(deps: RunProcessDeps, caller: Caller, upload: ImportUpload): Promise<{ importId: string; chainId: string }> {
  const chainId = caller.chainId ?? randomUUID();
  // The process refuses a name that is neither .xlsx nor .csv; the format then fixes the stored type.
  const mimeType = importMimeType(importFormatOf(upload.fileName) ?? "csv");
  const { importId } = (await runProcess(deps, { ...caller, chainId }, "kernel.import.run", {
    entity: upload.entity,
    fileName: upload.fileName,
    mimeType,
    sizeBytes: upload.bytes.byteLength,
  })) as { importId: string };
  const record = { importId, claims: caller.claims, chainId };

  try {
    await readImport(deps.registry, upload.entity, upload.bytes, upload.fileName);
  } catch (error) {
    if (!(error instanceof ImportFileError)) throw error;
    await failImport(deps.sql, record, error.message);
    throw fileRefusal(error);
  }

  const { tenant_id: tenantId, active_company_id: companyId } = caller.claims;
  const storagePath = `${tenantId}/${companyId}/kernel.import/${importId}/${randomUUID()}-${storageName(upload.fileName)}`;
  const store = await fileStore();
  // The step-up was spent on kernel.import.run; attaching is an ordinary process of the same chain.
  const { stepUpToken: _spent, ...plain } = caller;
  void _spent;
  try {
    await store.put(storagePath, Buffer.from(upload.bytes), mimeType);
    await runProcess(deps, { ...plain, chainId }, "kernel.attachment.add", {
      entity: "kernel.import",
      recordId: importId,
      tag: SOURCE_TAG,
      fileName: upload.fileName,
      mimeType,
      sizeBytes: upload.bytes.byteLength,
      storagePath,
    });
  } catch (error) {
    await store.remove(storagePath).catch(() => undefined);
    await failImport(deps.sql, record, "No se pudo guardar el archivo original");
    throw error;
  }
  return { importId, chainId };
}
