import { wallClock } from "./format";
import type { ExportFormat } from "./types";

// The name and type a generated file goes out under (design §9). Light on purpose: the process needs them to answer
// without loading the writers.

export const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

/** `terceros-2026-10-28.xlsx`: the title (or the entity) as a plain file name and the day in the company's zone. */
export function exportFileName(title: string | undefined, entity: string, format: ExportFormat, timeZone: string, now: Date = new Date()): string {
  const slug = (title ?? entity)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const day = wallClock(now, timeZone).toISOString().slice(0, 10);
  return `${slug || "exportacion"}-${day}.${format}`;
}
