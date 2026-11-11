import type { Registry } from "../registry";
import { importColumns, importLines, type ImportColumn, type ImportLines } from "./columns";
import { mapDocuments, mapSheet, type ImportLabels, type MappedSheet } from "./map";
import { ImportFileError, LINES_SHEET, parseImportBook, parseImportFile } from "./parse";
import { translatorFor } from "../registry/labels";
import { DOCUMENT_XLSX_ONLY } from "./template";

// An uploaded file read for the entity it is imported into (design §5.11 "map"): one sheet of records for any entity, and for a
// documento (entity types spec §2.5, D14) the header sheet and the Líneas sheet joined by `ref`, one record per document. Shared by
// the preview, the submission check and the workflow steps, so the three read the same records.

export interface ReadImport {
  columns: ImportColumn[];
  /** A documento's sheet names (errores.csv names each row with its sheet). */
  sheets: { header: string; lines: string } | null;
  /** The documento's lines layout, when it imports header and lines. */
  lines: ImportLines | null;
  sheet: MappedSheet;
}

/**
 * Reads and maps `bytes` for `entityId`; `locale` is the importer's, for the refusals the catalogue words (a document without lines).
 * Throws `ImportFileError` (a documento's file without its Líneas sheet among them).
 */
export async function readImport(registry: Registry, entityId: string, bytes: Uint8Array, fileName: string, labels: ImportLabels = {}, locale = "es-419"): Promise<ReadImport> {
  const columns = importColumns(registry, entityId);
  const lines = importLines(registry, entityId);
  if (!lines) return { columns, lines, sheets: null, sheet: mapSheet(columns, await parseImportFile(bytes, fileName), labels) };
  const book = await parseImportBook(bytes, fileName);
  if (!book.lines) throw new ImportFileError(DOCUMENT_XLSX_ONLY);
  return {
    columns,
    lines,
    sheets: { header: book.headerName ?? "Datos", lines: book.linesName ?? LINES_SHEET },
    sheet: mapDocuments(columns, lines, book, labels, translatorFor(locale)),
  };
}
