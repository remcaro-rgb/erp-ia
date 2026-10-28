import type { GridRow } from "../grid/types";

// Why a record cannot go on an invoice (design §5.17, prototype `invoiceReady`): the stored `invoice_ready` decides;
// the reasons come from what the record shows (inactive, DIAN data missing or wrong, else the required files).

export type InvoiceBlocker = { key: "inactive" } | { key: "dian"; items: string[] } | { key: "dian_errors" } | { key: "files" };

export function invoiceBlockers(row: GridRow): InvoiceBlocker[] {
  if (row.invoice_ready === true) return [];
  const blockers: InvoiceBlocker[] = [];
  if (row.is_active === false) blockers.push({ key: "inactive" });
  const status = typeof row.dian_status === "string" ? row.dian_status : "";
  if (status.startsWith("missing")) blockers.push({ key: "dian", items: Array.isArray(row.dian_missing) ? row.dian_missing.map(String) : [] });
  else if (status === "errors") blockers.push({ key: "dian_errors" });
  // DIAN-complete and active but still not ready: a required file is missing.
  if (blockers.length === 0) blockers.push({ key: "files" });
  return blockers;
}

/** The next highlighted item for an arrow key, wrapping around (prototype `lkKey`). */
export function moveHighlight(index: number, count: number, step: 1 | -1): number {
  if (count === 0) return 0;
  return (index + step + count) % count;
}
