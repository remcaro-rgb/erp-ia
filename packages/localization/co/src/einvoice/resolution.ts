/**
 * DIAN numbering resolutions (design §5.7, plan 2B task 3). A resolution authorises a prefix and a
 * range of consecutive numbers for a validity window; it lives in `core.document_sequences.resolution`
 * and numbers are drawn only through `core.next_document_number`, which locks the row. Every call
 * site (invoice, credit note, debit note issuing) goes through `nextInvoiceNumber`.
 */
export interface Resolution {
  /** Resolution number printed on the document (Serena: resolution_number). */
  number: string;
  prefix: string;
  from: number;
  to: number;
  /** ISO dates, inclusive. */
  validFrom: string;
  validTo: string;
  /** Technical key of the range, input of the CUFE. */
  technicalKey: string;
}

export type NumberedDocument = "invoice" | "credit_note" | "debit_note";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A positive integer the SQL check also accepts (at most 18 digits, safe in a JS number). */
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 1e18;

/**
 * A resolution's data without its technical key: what a refusal answers (Task 19 fix round 2: the key is stored apart, in
 * core.document_resolution_keys, and answered only with a drawn invoice number).
 */
export function isResolutionData(value: unknown): value is Omit<Resolution, "technicalKey"> {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.number === "string" && r.number.length > 0 &&
    typeof r.prefix === "string" &&
    isCount(r.from) && isCount(r.to) && r.to >= r.from &&
    isRealDate(r.validFrom) && isRealDate(r.validTo) && r.validTo >= r.validFrom
  );
}

/** A resolution with its technical key (what an invoice number is drawn with: the CUFE's input). */
export function isResolution(value: unknown): value is Resolution {
  if (!isResolutionData(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r.technicalKey === "string" && r.technicalKey.length > 0;
}

/** `no_sequence`: a note's type has no numbering row (a note is numbered by a plain sequence, never a DIAN resolution: Task 18 fix round 1). */
export type ResolutionErrorCode = "out_of_range" | "expired" | "not_yet_valid" | "no_resolution" | "no_sequence";

export class ResolutionError extends Error {
  constructor(readonly code: ResolutionErrorCode, readonly resolution?: Resolution) {
    super(
      code === "no_resolution"
        ? "no DIAN resolution configured for this document type"
        : code === "no_sequence"
        ? "no numbering sequence configured for this document type"
        : `DIAN resolution ${resolution?.number ?? ""} ${code}`,
    );
    this.name = "ResolutionError";
  }
}

/** A postgres.js-style transaction (tagged template). Kept structural so the pack has no database dependency. */
export type NumberingTx = (strings: TemplateStringsArray, ...values: never[]) => PromiseLike<readonly Record<string, unknown>[]>;

export interface InvoiceNumber {
  prefix: string;
  number: number;
  /** prefix + number, no padding: what the DIAN document carries. */
  full: string;
  /** The resolution the number was drawn from (core.next_document_number answers it since migration 0091), when it is a valid one. */
  resolution?: Resolution;
}

type Drawn = { status: "ok"; prefix: string; number: number; resolution?: unknown } | { status: ResolutionErrorCode; resolution?: Resolution };

/**
 * Draws the next consecutive number of the company's resolution for `type` (an invoice), or of its plain sequence (a credit or debit note:
 * the DIAN authorizes no range for notes; a row that carries a resolution keeps its prefix and range). The increment commits or rolls
 * back with the caller's transaction, so a failed issuing leaves no gap.
 */
export async function nextInvoiceNumber(tx: NumberingTx, companyId: string, type: NumberedDocument, issuedAt: string): Promise<InvoiceNumber> {
  const rows = await (tx as (s: TemplateStringsArray, ...v: unknown[]) => PromiseLike<readonly Record<string, unknown>[]>)`
    select core.next_document_number(${companyId}::uuid, ${type}, ${issuedAt}::date) as result`;
  const result = rows[0]?.result as Drawn | undefined;
  if (!result) throw new ResolutionError("no_resolution");
  if (result.status !== "ok") throw new ResolutionError(result.status, result.resolution);
  return { prefix: result.prefix, number: result.number, full: `${result.prefix}${result.number}`, ...(isResolution(result.resolution) ? { resolution: result.resolution } : {}) };
}
