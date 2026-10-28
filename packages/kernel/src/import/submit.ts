import { randomUUID } from "node:crypto";
import { fileStore } from "../files/store";
import type { Caller } from "../process/context";
import { ProcessError } from "../process/errors";
import { runProcess, type RunProcessDeps } from "../process/run";
import type { ImportColumn } from "./columns";
import { failImport, SOURCE_TAG } from "./job";
import { columnLabel, mapSheet, type ImportLabels } from "./map";
import { ImportFileError, parseImportFile } from "./parse";
import { resolveReferences, runRecords } from "./validate";

// What a server entry point (the import route, later the assistant) does with an uploaded file, as the caller.
// `previewImport` checks it without writing anything; `submitImport` creates the import record and attaches the
// file, after which the caller starts the `runImport` workflow with the returned id and chain.

export interface ImportUpload {
  entity: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

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
  let sheet;
  try {
    sheet = await parseImportFile(upload.bytes, upload.fileName);
  } catch (error) {
    if (error instanceof ImportFileError) throw fileRefusal(error);
    throw error;
  }
  const mapped = mapSheet(columns, sheet, labels);
  const shown = mapped.records.slice(0, PREVIEW_ROWS);
  await resolveReferences(deps, caller, columns, shown, labels);
  const outcomes = await runRecords(deps, caller, createProcess, columns, shown.map((record, index) => ({ index, record })), { dryRun: true, labels });
  const byKey = new Map(columns.map((c) => [c.key, c]));
  return {
    entity: upload.entity,
    fileName: upload.fileName,
    columns: columns.map((c) => ({ key: c.key, label: columnLabel(c, labels), required: c.required })),
    headers: mapped.headers,
    unknownHeaders: mapped.unknownHeaders,
    missingColumns: mapped.missingColumns.map((key) => columnLabel(byKey.get(key)!, labels)),
    total: mapped.records.length,
    rows: outcomes.map((o) => ({ rowNo: o.rowNo, ok: o.ok, errors: o.errors, cells: mapped.headers.map((h) => shown[o.index]!.raw[h] ?? "") })),
  };
}

/**
 * Starts an import as the caller: runs `kernel.import.run` (step-up, permission, the import record), stores the file
 * and attaches it to the record as its source. Returns the import id and the chain to start `runImport` with. When
 * the file cannot be attached the import is recorded as failed and the refusal is thrown.
 */
export async function submitImport(deps: RunProcessDeps, caller: Caller, upload: ImportUpload): Promise<{ importId: string; chainId: string }> {
  const chainId = caller.chainId ?? randomUUID();
  const { importId } = (await runProcess(deps, { ...caller, chainId }, "kernel.import.run", {
    entity: upload.entity,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.bytes.byteLength,
  })) as { importId: string };

  const { tenant_id: tenantId, active_company_id: companyId } = caller.claims;
  const storagePath = `${tenantId}/${companyId}/kernel.import/${importId}/${randomUUID()}-${storageName(upload.fileName)}`;
  const store = await fileStore();
  // The step-up was spent on kernel.import.run; attaching is an ordinary process of the same chain.
  const { stepUpToken: _spent, ...plain } = caller;
  void _spent;
  try {
    await store.put(storagePath, Buffer.from(upload.bytes), upload.mimeType);
    await runProcess(deps, { ...plain, chainId }, "kernel.attachment.add", {
      entity: "kernel.import",
      recordId: importId,
      tag: SOURCE_TAG,
      fileName: upload.fileName,
      mimeType: upload.mimeType,
      sizeBytes: upload.bytes.byteLength,
      storagePath,
    });
  } catch (error) {
    await store.remove(storagePath).catch(() => undefined);
    await failImport(deps.sql, { importId, claims: caller.claims, chainId }, "No se pudo guardar el archivo original");
    throw error;
  }
  return { importId, chainId };
}
