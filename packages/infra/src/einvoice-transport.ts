import { createHash } from "node:crypto";

// The electronic-invoice transport seam (design §18a, §19 "left to the builder": direct DIAN submission first, a technology
// provider later, both behind this interface). The Docker stack and CI use `MockEInvoiceTransport`; the hosted demo uses the
// DIAN habilitación client (`@erp/loc-co/einvoice`, `createEInvoiceTransport`), which lives in the Colombia pack because it is
// fiscal logic (rule 5) and implements this interface.

/**
 * `not_found` is answered only by `poll`: the authority has no document under that trackId (it was never received: the send failed before
 * reaching it). It is not a verdict; a caller whose earlier send is in doubt may send the document again on that answer (Task 17 fix round 1).
 */
export type EInvoiceStatus = "accepted" | "rejected" | "pending" | "not_found";

export interface EInvoiceSubmitMeta {
  /** CUFE / CUDE of the document: the idempotency key of a submission. */
  cufe: string;
  /** Number with prefix, e.g. SETP990000001. */
  documentNumber: string;
  /** Issuer NIT without DV. */
  issuerNit: string;
  /** Habilitación test-set id: when present the real transport sends SendTestSetAsync (always pending first). */
  testSetId?: string;
}

export interface EInvoiceResult {
  trackId: string;
  status: EInvoiceStatus;
  errors: string[];
  /** The authority's ApplicationResponse XML when one came back. */
  applicationResponse?: string;
}

export interface EInvoiceTransport {
  readonly name: string;
  submit(signedXml: string, meta: EInvoiceSubmitMeta): Promise<EInvoiceResult>;
  /** The verdict under `trackId`; `not_found` when the authority never received a document under it. */
  poll(trackId: string): Promise<EInvoiceResult>;
  /**
   * The trackId a submission of this document gets, known before sending it, or null when only the authority's answer tells it (an
   * asynchronous test set). A caller whose submit lost its answer (timeout after sending) polls this id instead of sending again.
   */
  expectedTrackId?(meta: EInvoiceSubmitMeta): string | null;
}

/** Transient failure (network, HTTP error): the document is neither accepted nor rejected, the caller retries. */
export class EInvoiceTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EInvoiceTransportError";
  }
}

export type MockScenario = "accepted" | "rejected" | "pending";

export interface MockEInvoiceOptions {
  /** Outcome per document; default accepted. `pending` becomes accepted after `pendingPolls` polls. */
  scenario?: (meta: EInvoiceSubmitMeta) => MockScenario;
  /** Polls that still answer pending for a pending document (default 1: the first poll accepts). */
  pendingPolls?: number;
  /** Mock "DIAN" this instance talks to (default "default"): instances of one namespace share every document. */
  namespace?: string;
}

interface MockRecord {
  meta: EInvoiceSubmitMeta;
  /** Fingerprint of the signed document last validated: a rejected document sent again with another content is validated again. */
  digest: string;
  scenario: MockScenario;
  pollsLeft: number;
  errors: string[];
}

/** UUID-shaped, derived only from the CUFE: the same document gets the same trackId in every process and run. */
export function mockTrackId(cufe: string): string {
  const h = createHash("sha256").update(`mock-dian-track:${cufe}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Process-wide store: the factory builds a new mock per call (web route, worker step), but submit and poll of one document must
 * see the same state, as they would against the real DIAN. Keyed by namespace; `resetMockEInvoiceState` is for tests. Kept on
 * globalThis (Task 17): a workflow step bundle loads this module a second time and must see the documents the first copy holds.
 */
const STORE_KEY = Symbol.for("erp.infra.mockEInvoiceStore");
const storeGlobals = globalThis as { [STORE_KEY]?: Map<string, Map<string, MockRecord>> };
const STORE: Map<string, Map<string, MockRecord>> = (storeGlobals[STORE_KEY] ??= new Map<string, Map<string, MockRecord>>());
/** The document without its signature (a signature carries its signing time: the same document signed again is the same document). */
const digestOf = (xml: string) => {
  const unsigned = xml.includes("</ds:Signature>") ? xml.replace(/<ds:Signature\b[\s\S]*?<\/ds:Signature>/, "") : xml.replace(/<ds:Signature\b[^>]*\/>/, "");
  return createHash("sha256").update(unsigned).digest("hex");
};

export function resetMockEInvoiceState(namespace?: string): void {
  if (namespace === undefined) STORE.clear();
  else STORE.delete(namespace);
}

const xmlEsc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Simulated DIAN (ported in spirit from Serena `mock.ts`): never leaves the process, never has fiscal validity. */
export class MockEInvoiceTransport implements EInvoiceTransport {
  readonly name = "mock";
  constructor(private readonly options: MockEInvoiceOptions = {}) {}

  /** Looked up on every call so a reset takes effect on instances that already exist. */
  private get records(): Map<string, MockRecord> {
    const ns = this.options.namespace ?? "default";
    let map = STORE.get(ns);
    if (!map) STORE.set(ns, (map = new Map<string, MockRecord>()));
    return map;
  }

  expectedTrackId(meta: EInvoiceSubmitMeta): string {
    return mockTrackId(meta.cufe);
  }

  /**
   * The same CUFE answers what the "DIAN" has: a pending or accepted document is never validated again. A rejected one is not received
   * (DIAN keeps no rejected document): sent again with the same content it gets the same rejection, sent corrected (same number and
   * CUFE, another content) it is validated again under the same trackId.
   */
  async submit(signedXml: string, meta: EInvoiceSubmitMeta): Promise<EInvoiceResult> {
    const trackId = mockTrackId(meta.cufe);
    const known = this.records.get(trackId);
    if (known && (known.scenario !== "rejected" || known.digest === digestOf(signedXml))) return this.view(trackId, known);
    const unsigned = !signedXml.includes("<ds:Signature");
    const scenario: MockScenario = unsigned ? "rejected" : (this.options.scenario?.(meta) ?? "accepted");
    const errors =
      scenario !== "rejected"
        ? []
        : unsigned
          ? ["Documento sin firma electrónica (ds:Signature)"]
          : ["Rechazo simulado: validación de la DIAN fallida"];
    const record: MockRecord = { meta, digest: digestOf(signedXml), scenario, pollsLeft: scenario === "pending" ? Math.max(1, this.options.pendingPolls ?? 1) : 0, errors };
    this.records.set(trackId, record);
    return this.view(trackId, record);
  }

  async poll(trackId: string): Promise<EInvoiceResult> {
    const record = this.records.get(trackId);
    // Never received (a send that failed before reaching the "DIAN"): not a rejection.
    if (!record) return { trackId, status: "not_found", errors: [] };
    if (record.scenario === "pending" && record.pollsLeft > 0) {
      record.pollsLeft -= 1;
      if (record.pollsLeft === 0) record.scenario = "accepted";
      else return this.view(trackId, record);
    }
    return this.view(trackId, record);
  }

  private view(trackId: string, r: MockRecord): EInvoiceResult {
    if (r.scenario === "pending") return { trackId, status: "pending", errors: [] };
    if (r.scenario === "rejected") return { trackId, status: "rejected", errors: [...r.errors] };
    return {
      trackId,
      status: "accepted",
      errors: [],
      applicationResponse: `<ApplicationResponse><Note>Procesado Correctamente (SIMULADO, no enviado a la DIAN)</Note><TrackId>${xmlEsc(trackId)}</TrackId><DocumentNumber>${xmlEsc(r.meta.documentNumber)}</DocumentNumber><UUID>${xmlEsc(r.meta.cufe)}</UUID></ApplicationResponse>`,
    };
  }
}
