import type { JournalKind } from "@erp/kernel";

/** The seven default Fuentes (accounting design §4.3); Apertura and Cierre take no manual entries. */
export const defaultJournals = (): { code: string; name: string; kind: JournalKind; manualEntries: boolean }[] => [
  { code: "NC", name: "Notas de contabilidad", kind: "general", manualEntries: true },
  { code: "VT", name: "Ventas", kind: "sales", manualEntries: true },
  { code: "CP", name: "Compras", kind: "purchases", manualEntries: true },
  { code: "RC", name: "Recibos de caja", kind: "receipts", manualEntries: true },
  { code: "CE", name: "Comprobantes de egreso", kind: "payments", manualEntries: true },
  { code: "AP", name: "Apertura", kind: "opening", manualEntries: false },
  { code: "CI", name: "Cierre", kind: "closing", manualEntries: false },
];
