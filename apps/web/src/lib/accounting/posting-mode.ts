// The posting mode card of Reglas contables › Mapeo de cuentas (Task 33, R33-9): what the page needs of `accounting.settings.consult`, pure so it is unit-tested.

export const POSTING_MODES = ["inline_strict", "asynchronous"] as const;
export type PostingMode = (typeof POSTING_MODES)[number];

export interface PostingModeData {
  mode: PostingMode;
  /** Documents with an event waiting for the consumer. */
  pendingDocuments: number;
  /** Failures in the retry queue (Pendientes). */
  pendingFailures: number;
  /** The processes of the documentos the mode applies to (`inlinePostingProcesses`), as catalogue keys (`invoicing_invoice_issue`). */
  documents: string[];
}

/** `invoicing.invoice.issue` → `invoicing_invoice_issue`: the key of its name under `accounting.pages.posting.mode.document`. */
export const documentKey = (processId: string): string => processId.replaceAll(".", "_");

/** The consult's answer (or nothing, when the caller could not read it) as the card shows it: the default mode is the strict one. */
export function postingModeData(consult: Record<string, unknown> | null, processIds: readonly string[]): PostingModeData {
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0);
  return {
    mode: consult?.postingMode === "asynchronous" ? "asynchronous" : "inline_strict",
    pendingDocuments: count(consult?.pendingDocuments),
    pendingFailures: count(consult?.pendingFailures),
    documents: processIds.map(documentKey),
  };
}
