// What the import dialog and the import page show (design §9, prototype `openImport` / `renderImportPage`), as
// plain data from the import route (`/api/import`). Pure, so the rules are unit-tested.

/** One previewed row: validated with the entity's create process in a dry run. */
export interface ImportPreviewRow {
  rowNo: number;
  ok: boolean;
  errors: string[];
  /** The row's cells in header order. */
  cells: string[];
}

/** The route's preview of a file (kernel `ImportPreview`). */
export interface ImportPreviewData {
  entity: string;
  fileName: string;
  headers: string[];
  unknownHeaders: string[];
  /** Labels of the required columns the file lacks. */
  missingColumns: string[];
  total: number;
  rows: ImportPreviewRow[];
  /** A documento's lines refused on their own (their ref names no document), by their Líneas row: line errors, not refused rows. */
  lineErrors?: { rowNo: number; errors: string[] }[];
}

/** One import of the history (kernel `ImportItem`). */
export interface ImportHistoryItem {
  id: string;
  entity: string | null;
  status: string | null;
  rowsTotal: number | null;
  rowsOk: number | null;
  rowsFailed: number | null;
  fileName: string | null;
  errorsAttachmentId: string | null;
  startedByName: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** Rows done of a running import (ok + refused, never above the total), or null when it is not running or has no total. */
export function importProgress(item: Pick<ImportHistoryItem, "status" | "rowsTotal" | "rowsOk" | "rowsFailed">): { done: number; total: number; ratio: number } | null {
  if (item.status !== "running" || !item.rowsTotal) return null;
  const done = Math.min(item.rowsTotal, (item.rowsOk ?? 0) + (item.rowsFailed ?? 0));
  return { done, total: item.rowsTotal, ratio: done / item.rowsTotal };
}

/** Columns of the file shown in the preview table, after the row number and the result. */
export const PREVIEW_COLUMNS = 6;

/** Valid and refused rows among the previewed ones. */
export function previewCounts(preview: ImportPreviewData): { valid: number; invalid: number } {
  const valid = preview.rows.filter((r) => r.ok).length;
  return { valid, invalid: preview.rows.length - valid };
}

/** "Importar filas válidas" is offered once the preview found a valid row and no required column is missing. */
export const canRunImport = (preview: ImportPreviewData | null): boolean =>
  preview !== null && preview.missingColumns.length === 0 && preview.rows.some((r) => r.ok);

/** The template download of `entity` in `format`. */
export const templateHref = (endpoint: string, entity: string, format: "xlsx" | "csv") =>
  `${endpoint}?${new URLSearchParams({ entity, format }).toString()}`;

/** Files the import reads: .xlsx and .csv (or .txt) up to 25 MB. */
export function fileProblem(file: File, maxBytes: number): "too_big" | "wrong_type" | null {
  if (!/\.(xlsx|csv|txt)$/i.test(file.name)) return "wrong_type";
  return file.size > maxBytes ? "too_big" : null;
}

/** An import still in progress: the history refreshes until none is. */
export const importPending = (items: readonly ImportHistoryItem[]) => items.some((i) => i.status === "queued" || i.status === "running");

/** The message of a refused request: the process's details, else its code. */
export async function refusalOf(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json().catch(() => null)) as { code?: string; details?: unknown } | null;
  const code = body?.code ?? `http_${response.status}`;
  const details = Array.isArray(body?.details)
    ? body.details.map((d) => (typeof d === "string" ? d : typeof d === "object" && d && "message" in d ? String((d as { message: unknown }).message) : "")).filter(Boolean)
    : [];
  return { code, message: details.length > 0 ? details.join(" · ") : code };
}
