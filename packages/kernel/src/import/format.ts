/** The file formats an import reads and a template is written in. */
export type ImportFormat = "csv" | "xlsx";

/** The format a file name declares (`.csv` / `.txt` read as CSV, `.xlsx`), or null for anything else. */
export function importFormatOf(fileName: string): ImportFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(fileName.trim())?.[1]?.toLowerCase();
  return ext === "csv" || ext === "txt" ? "csv" : ext === "xlsx" ? "xlsx" : null;
}
