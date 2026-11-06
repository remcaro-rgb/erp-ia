import { FatalError, RetryableError, getStepMetadata, getWorkflowMetadata, sleep } from "workflow";
import type { EInvoiceResult, EInvoiceSubmitMeta, EInvoiceTransport } from "@erp/infra";
import {
  buildConsumerContext, countryPack, fileStore, getServiceDb, installedEInvoiceTransport, secretStore, type EInvoiceDocumentInput, type EInvoiceNoteInput,
} from "@erp/kernel";
import { softwarePinSecret } from "../einvoice-secrets";

// The e-invoice workflow (plan 2B Task 17; design §18a, §19, OD-1; rule 6: durable work only through `workflow`, started by the
// DurableRunner from the consumer of invoicing.invoice.issued or of «Reintentar envío»). One run per sending of one invoice:
//
//   claim → build the UBL document from the invoice as issued and sign it (the country pack, rule 5; the company's certificate and software
//   PIN from the secret store, rule 12), and keep the signed XML in the file store under the sending round, BEFORE it is sent → submit
//   through the EInvoiceTransport seam → poll the verdict by trackId with backoff (a FatalError after the limit) → store the
//   ApplicationResponse next to the XML → invoicing.invoice.dian_result (accepted or rejected, with the DIAN's errors) → accepted, the PDF
//   of the document (its template, CUFE, QR and resolution legend: Task 19) kept once next to them (pdf_path).
//
// Every write is a process of the module run as the event's system user on the issue's chain (origin event): the run changes nothing by
// itself. Exactly-once toward the DIAN: before calling the transport the run records the attempt. A step retried after an attempt (its
// answer lost: a timeout once sent, a crash, or a send that never left) asks the DIAN for the document's trackId first: found, it is polled
// and never sent again; `not_found` (the DIAN never received it) is the only answer on which it is sent again, counted again first. A
// resumed round (a retry, «Reintentar envío» after a failure) sends the XML kept for it, byte for byte, never a new signature: the file kept
// is the document the DIAN validated. A replayed run reuses the recorded result of every finished step. A run that is not the
// submission's owner (a redelivered event lost the claim) exits at once.
// Any stop records `failed` with the reason (the invoice page shows it; «Reintentar envío» resumes) and ends the run with a FatalError.
// A credit or debit note (Task 18, `noteId`) runs the same steps: its document is built by the pack's buildNoteXml, which answers its CUDE
// (the software PIN is an input: computed here, recorded with the attempt and on the note once), its files go under the note, and its
// verdict is invoicing.note.dian_result (an accepted annulment note voids the invoice there).

export interface EInvoiceRunArgs {
  companyId: string;
  invoiceId: string;
  /** A credit or debit note of the invoice (Task 18): the run sends the note, not the invoice. */
  noteId?: string;
  submissionId: string;
  /** The causal chain of the issue (rule 16): every process of the run and the accepted / rejected events carry it. */
  chainId: string;
  /** Polls before the run gives up (default 20, about two and a half hours of backoff). */
  maxPolls?: number;
}

export interface EInvoiceRunOutcome {
  submissionId: string;
  status: "accepted" | "rejected" | "not_owner";
  trackId?: string;
}

const MAX_POLLS = 20;
/** Backoff of the n-th poll (0-based), in ms: 10 s, 20 s, 40 s … capped at 10 minutes. */
const pollDelay = (n: number) => Math.min(10 * 2 ** n, 600) * 1000;

interface Prepared {
  signedXml: string;
  /** A note's CUDE (recorded with the attempt); an invoice's CUFE is already on the submission. */
  code?: string;
  /** Where the signed XML of the round is kept (written before the first send). */
  xmlPath: string;
  meta: EInvoiceSubmitMeta;
  round: number;
}

interface SubmissionState {
  status: string;
  round: number;
  attempts: number;
  trackId: string | null;
  runId: string | null;
}

export async function einvoiceSubmission(args: EInvoiceRunArgs): Promise<EInvoiceRunOutcome> {
  "use workflow";

  const { workflowRunId } = getWorkflowMetadata();
  if (!(await claimSubmission(args, workflowRunId))) return { submissionId: args.submissionId, status: "not_owner" };
  try {
    const prepared = await prepareDocument(args);
    let result = await submitDocument(args, workflowRunId, prepared);
    const limit = args.maxPolls ?? MAX_POLLS;
    for (let n = 0; result.status === "pending"; n++) {
      if (n >= limit) throw new FatalError(`poll_limit: la DIAN no respondió tras ${limit} consultas del seguimiento ${result.trackId}; «Reintentar envío» consulta de nuevo, sin reenviar`);
      await sleep(pollDelay(n));
      result = await pollDocument(args, workflowRunId, result.trackId);
    }
    const files = await storeResponse(args, prepared, result);
    await recordVerdict(args, workflowRunId, result, files);
    if (result.status === "accepted") {
      // The graphic representation (Task 19): stored once the DIAN accepted the document. The verdict is already recorded: a PDF that could
      // not be stored is not a failed sending (the document prints from its page all the same), so its error stops here.
      try {
        await storePdf(args);
      } catch {
        // The step retried and gave up: pdf_path stays empty.
      }
    }
    return { submissionId: args.submissionId, status: result.status as "accepted" | "rejected", trackId: result.trackId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(args, workflowRunId, message);
    throw new FatalError(message);
  }
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

/** Runs a process of the module as the event's system user, on the issue's chain (what the outbox consumers do). */
function runAsEvent<T>(args: EInvoiceRunArgs, processId: string, input: unknown): Promise<T> {
  return buildConsumerContext(getServiceDb(), { companyId: args.companyId, chainId: args.chainId }).runProcess(processId, input) as Promise<T>;
}

/**
 * Workflow-level transport: the installed override (tests) or the pack's, from configuration (the mock unless configured otherwise). Either
 * must serve the company's DIAN environment (Task 19): the mock or habilitación never send the document of a company in producción, nor
 * the production transport a habilitación one. A mismatch stops the run before anything is sent (not retried: configuration, not network).
 */
async function transportFor(args: EInvoiceRunArgs): Promise<EInvoiceTransport> {
  const companyId = args.companyId;
  const db = getServiceDb();
  // The document's environment, frozen at «Emitir» (Task 19 fix round 1), else the company's.
  const [company] = await db<{ country_code: string; dian_environment: "habilitacion" | "produccion" | null }[]>`
    select c.country_code,
           coalesce(${args.noteId ? db`(select dian_environment from invoicing.notes where id = ${args.noteId})` : db`(select dian_environment from invoicing.invoices where id = ${args.invoiceId})`},
                    s.dian_environment) as dian_environment
    from kernel.companies c left join invoicing.settings s on s.company_id = c.id where c.id = ${companyId}`;
  const einvoice = countryPack(company!.country_code).einvoice;
  if (!einvoice) throw new FatalError("einvoice_not_available: el paquete del país no tiene facturación electrónica registrada");
  const environment = company!.dian_environment ?? "habilitacion";
  try {
    const installed = installedEInvoiceTransport();
    if (installed) {
      einvoice.assertTransportEnvironment(installed, environment);
      return installed;
    }
    return einvoice.transport({ secrets: secretStore(), companyId, environment });
  } catch (error) {
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
}

/** A transport failure is not a verdict (network, HTTP, timeout): retried with backoff. Matched by name: the step bundle may load a second copy of infra. */
function transient(error: unknown): RetryableError | null {
  if (!(error instanceof Error) || error.name !== "EInvoiceTransportError") return null;
  return new RetryableError(error.message, { retryAfter: Math.min(2 ** (getStepMetadata().attempt - 1), 60) * 1000 });
}

async function state(args: EInvoiceRunArgs, runId: string, action: string, extra: Record<string, unknown> = {}): Promise<{ owned: boolean; submission: SubmissionState }> {
  return runAsEvent(args, "invoicing.einvoice_submission.record", { action, id: args.submissionId, runId, ...extra });
}

/** Claims the submission for this run; false when another run owns it or it is not queued (a redelivery). */
async function claimSubmission(args: EInvoiceRunArgs, runId: string): Promise<boolean> {
  "use step";
  return (await state(args, runId, "claim")).owned;
}

/** The signed XML of a sending round in the file store (the ApplicationResponse goes next to it). */
const roundBase = (args: EInvoiceRunArgs, round: number) =>
  args.noteId ? `einvoice/${args.companyId}/${args.invoiceId}/notas/${args.noteId}/envio-${round}` : `einvoice/${args.companyId}/${args.invoiceId}/envio-${round}`;

async function storedText(path: string): Promise<string | null> {
  const store = await fileStore();
  try {
    return new TextDecoder().decode(await store.get(path));
  } catch {
    return null;
  }
}

/**
 * Builds the document from the invoice as issued through the country pack, checks it carries the invoice's CUFE, signs it, and keeps it in
 * the file store under its round before anything is sent. A round already kept (a resumed one) answers the XML kept, not a new signature.
 */
async function prepareDocument(args: EInvoiceRunArgs): Promise<Prepared> {
  "use step";
  type Read = { ok: boolean; code?: string; message?: string; kind: "invoice" | "note"; cufe: string | null; testSetId: string | null; round: number; document: Omit<EInvoiceNoteInput, "software"> & { software: { id: string; providerTaxId: string } } };
  const read = await runAsEvent<Read>(args, "invoicing.einvoice_submission.document", { id: args.submissionId });
  if (!read.ok) throw new FatalError(`${read.code}: ${read.message}`);
  const note = read.kind === "note";
  const xmlPath = `${roundBase(args, read.round)}/${note ? "nota" : "factura"}-${read.document.number}.xml`;
  const metaOf = (code: string): EInvoiceSubmitMeta => ({ cufe: code, documentNumber: read.document.number, issuerNit: read.document.issuer.taxId, ...(read.testSetId ? { testSetId: read.testSetId } : {}) });
  // A round already kept (a resumed one) sends the XML kept; a note's CUDE is the one recorded with its first attempt.
  const kept = await storedText(xmlPath);
  if (kept !== null && (!note || read.cufe)) return { signedXml: kept, xmlPath, meta: metaOf(read.cufe!), round: read.round, ...(note ? { code: read.cufe! } : {}) };
  const secrets = secretStore();
  if (!secrets) throw new FatalError("credentials not configured: no secret store is installed for the DIAN certificate and the software PIN");
  const pin = await secrets.get(softwarePinSecret(args.companyId));
  if (!pin) throw new FatalError("einvoice_not_configured: credentials not configured: the software PIN registered with the DIAN is not stored");
  const einvoice = countryPack(read.document.issuer.countryCode).einvoice;
  if (!einvoice) throw new FatalError("einvoice_not_available: el paquete del país no tiene facturación electrónica registrada");
  let xml: string;
  let code: string;
  if (note) {
    // The note's document and its CUDE (deterministic: the same inputs give the same code; a code other than its first sending's is refused).
    ({ xml, code } = einvoice.buildNoteXml({ ...(read.document as Omit<EInvoiceNoteInput, "software">), software: { ...read.document.software, pin } }));
    if (read.cufe && code !== read.cufe) throw new FatalError(`cude_changed: el documento de hoy tendría otro CUDE que el de su primer envío (${read.cufe.slice(0, 12)}…): se corrige con otra nota`);
  } else {
    // An invoice's document carries no note fields (kind, concept, reference): invoicing.einvoice_submission.document answers them for a note only.
    const document = { ...(read.document as Omit<EInvoiceDocumentInput, "software">), software: { ...read.document.software, pin } };
    ({ xml, code } = einvoice.buildInvoiceXml(document));
    // An invoice issued before Task 18's fix round 1 had its CUFE computed over the customer's id reduced to its digits (a foreign id with
    // letters): its document is built the same way, so the XML carries what its CUFE names.
    if (code !== read.cufe) {
      const legacy = einvoice.buildInvoiceXml({ ...document, customerIdDigitsOnly: true });
      if (legacy.code === read.cufe) ({ xml, code } = legacy);
    }
    if (code !== read.cufe) throw new FatalError(`cufe_changed: el documento de hoy tendría otro CUFE que la factura emitida (${read.cufe?.slice(0, 12)}…): se corrige con una nota, no se reenvía`);
  }
  const meta = metaOf(code);
  const extra = note ? { code } : {};
  // A note's round kept before its CUDE was recorded (a crash between the two): the XML kept, the code computed again.
  if (kept !== null) return { signedXml: kept, xmlPath, meta, round: read.round, ...extra };
  let signedXml: string;
  try {
    signedXml = await einvoice.signXml(xml, secrets, args.companyId);
  } catch (error) {
    throw new FatalError(error instanceof Error ? error.message : String(error));
  }
  // Kept before it is sent (write once: the file store never overwrites; a retry that finds it sends what it holds).
  const store = await fileStore();
  try {
    await store.put(xmlPath, Buffer.from(signedXml, "utf8"), "application/xml");
  } catch (error) {
    const raced = await storedText(xmlPath);
    if (raced === null) throw error;
    return { signedXml: raced, xmlPath, meta, round: read.round, ...extra };
  }
  return { signedXml, xmlPath, meta, round: read.round, ...extra };
}

/**
 * Sends the document once per round. The attempt is recorded before the transport is called. An attempt found recorded (its answer lost)
 * is not sent again while the DIAN has it: its trackId (the transport knows it from the document) is polled, and only `not_found` (never
 * received) lets it be sent again. A round that already has its trackId polls it.
 */
async function submitDocument(args: EInvoiceRunArgs, runId: string, prepared: Prepared): Promise<EInvoiceResult> {
  "use step";
  const transport = await transportFor(args);
  // A claim by the owner answers the submission as it stands (what an earlier attempt of this step recorded).
  const { owned, submission } = await state(args, runId, "claim");
  if (!owned) throw new FatalError("not_owner: otra ejecución tiene este envío");
  if (submission.trackId) return { trackId: submission.trackId, status: "pending", errors: [] };
  if (submission.attempts > 0) {
    const trackId = transport.expectedTrackId?.(prepared.meta) ?? null;
    if (!trackId) throw new FatalError("submission_in_doubt: el envío anterior pudo llegar a la DIAN y su número de seguimiento no se conoce: verifícalo en el portal de la DIAN");
    let found: EInvoiceResult;
    try {
      found = await transport.poll(trackId);
    } catch (error) {
      throw transient(error) ?? error;
    }
    await state(args, runId, "polled");
    if (found.status !== "not_found") {
      await state(args, runId, "submitted", { trackId });
      return found;
    }
    // The DIAN never received the earlier attempt: sent again below (counted again first).
  }
  await state(args, runId, "submitting", { xmlPath: prepared.xmlPath, ...(prepared.code ? { code: prepared.code } : {}) });
  let result: EInvoiceResult;
  try {
    result = await transport.submit(prepared.signedXml, prepared.meta);
  } catch (error) {
    throw transient(error) ?? error;
  }
  if (result.status === "not_found") throw new FatalError("einvoice_transport: la DIAN respondió al envío sin recibir el documento");
  await state(args, runId, "submitted", { trackId: result.trackId });
  return result;
}
submitDocument.maxRetries = 5;

/** One poll of the verdict by trackId. */
async function pollDocument(args: EInvoiceRunArgs, runId: string, trackId: string): Promise<EInvoiceResult> {
  "use step";
  const transport = await transportFor(args);
  let result: EInvoiceResult;
  try {
    result = await transport.poll(trackId);
  } catch (error) {
    throw transient(error) ?? error;
  }
  await state(args, runId, "polled");
  // A trackId the DIAN acknowledged and does not find yet: still pending (polled again, up to the limit).
  return result.status === "not_found" ? { ...result, status: "pending" } : result;
}
pollDocument.maxRetries = 5;

/**
 * Keeps the ApplicationResponse next to the round's signed XML (already kept before the send). The file store never overwrites: a retried
 * step removes what an earlier attempt of it may have written, then writes.
 */
async function storeResponse(args: EInvoiceRunArgs, prepared: Prepared, result: EInvoiceResult): Promise<{ xmlPath: string; responsePath: string | null }> {
  "use step";
  if (!result.applicationResponse) return { xmlPath: prepared.xmlPath, responsePath: null };
  const store = await fileStore();
  const responsePath = `${roundBase(args, prepared.round)}/respuesta-dian-${result.status}.xml`;
  await store.remove(responsePath).catch(() => undefined);
  await store.put(responsePath, Buffer.from(result.applicationResponse, "utf8"), "application/xml");
  return { xmlPath: prepared.xmlPath, responsePath };
}

async function recordVerdict(args: EInvoiceRunArgs, runId: string, result: EInvoiceResult, files: { xmlPath: string; responsePath: string | null }): Promise<void> {
  "use step";
  try {
    await runAsEvent(args, args.noteId ? "invoicing.note.dian_result" : "invoicing.invoice.dian_result", {
      id: args.noteId ?? args.invoiceId, submissionId: args.submissionId, runId, status: result.status, errors: result.errors, xmlPath: files.xmlPath, responsePath: files.responsePath,
    });
  } catch (error) {
    // A refusal of the verdict (e.g. the annulment of an invoice no longer issued) is not transient: the sending stops with it, not retried.
    if ((error as { code?: unknown }).code === "invalid_state") throw new FatalError(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Renders the accepted document with its template and keeps it in the file store (invoicing.einvoice_submission.store_pdf: once). */
async function storePdf(args: EInvoiceRunArgs): Promise<void> {
  "use step";
  await runAsEvent(args, "invoicing.einvoice_submission.store_pdf", { id: args.submissionId });
}

async function recordFailure(args: EInvoiceRunArgs, runId: string, message: string): Promise<void> {
  "use step";
  await state(args, runId, "failed", { error: message });
}
