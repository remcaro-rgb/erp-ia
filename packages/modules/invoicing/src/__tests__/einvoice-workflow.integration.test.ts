import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getRun, start } from "workflow/api";
import { EInvoiceTransportError, InMemorySecretStore, MockEInvoiceTransport, mockTrackId, type EInvoiceResult, type EInvoiceSubmitMeta, type EInvoiceTransport, type MockScenario } from "@erp/infra";
import { buildConsumerContext, consumers, loadModules, registry as appRegistry, setEInvoiceTransport, setExportsStore, setFileStore, setSecretStore } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { saveCertificate, verifySignedInvoice } from "@erp/loc-co/einvoice";
import { generateTestCertP12 } from "../../../../localization/co/src/__tests__/helpers/test-cert";
import { pdfText } from "../../../../kernel/src/templates/__tests__/pdf-text";
import { softwarePinSecret } from "../einvoice-secrets";
import { invoicing } from "../index";
import { FE } from "../pdf/invoice-template";
import { einvoiceSubmission } from "../workflows/einvoice.workflow";
import { transportFor } from "../workflows/transport-for";
import { DIAN_CHECKLIST_VERSION, invoicingHarness, MODULES, registry, type Harness, type InvoiceOut } from "./helpers";

// The DIAN submission of an issued invoice (plan 2B Task 17; design §18a, §19, OD-1; Review Focus 2), on the MOCK transport only (the owner
// has supplied no habilitación credentials): invoicing.invoice.issued → the e-invoice workflow builds the UBL document from the frozen
// invoice through the country pack, signs it with the company's certificate (a self-signed test certificate, in memory, through the secret
// store seam), sends it, polls the verdict by trackId with backoff, stores the signed XML and the ApplicationResponse in the file store and
// records the verdict with invoicing.invoice.dian_result (event origin only), which moves dian_status and emits accepted / rejected.
// The workflow runs in-process (@workflow/vitest); its steps run the module's processes as the consumers do (origin event, system user).

const FINAL = ["accepted", "rejected", "failed", "not_configured"];

/**
 * A mock DIAN the test scripts: the verdict per CUFE, sends that fail before reaching the DIAN, the answer of a submit lost after it reached
 * the DIAN, and what was tried, received (`submits`, `sentXml`) and polled.
 */
class ScriptedDian implements EInvoiceTransport {
  readonly name = "scripted-mock";
  /** Every call of submit, received or not. */
  tries = 0;
  /** The documents the DIAN received (what the mock recorded), and their signed XML byte for byte. */
  readonly submits: EInvoiceSubmitMeta[] = [];
  readonly sentXml: string[] = [];
  readonly polls: string[] = [];
  /** Sends that fail BEFORE reaching the DIAN (connection refused, DNS, TLS): nothing recorded. */
  failBeforeSend = 0;
  /** Submits whose answer is lost AFTER the DIAN recorded the document (a timeout once sent). */
  loseAnswers = 0;
  /** A transport that cannot tell a document's trackId before the answer (the asynchronous test set). */
  unknownTrackId = false;
  /** Called at each send, before anything else (what the database says while the document is on its way). */
  onSend?: () => Promise<void>;
  verdict: MockScenario = "accepted";
  readonly mock: MockEInvoiceTransport;
  constructor(namespace: string, pendingPolls = 1) {
    this.mock = new MockEInvoiceTransport({ namespace, pendingPolls, scenario: () => this.verdict });
  }
  expectedTrackId(meta: EInvoiceSubmitMeta): string | null {
    return this.unknownTrackId ? null : this.mock.expectedTrackId(meta);
  }
  async submit(signedXml: string, meta: EInvoiceSubmitMeta): Promise<EInvoiceResult> {
    this.tries += 1;
    await this.onSend?.();
    if (this.failBeforeSend > 0) {
      this.failBeforeSend -= 1;
      throw new EInvoiceTransportError("conexión rechazada por la DIAN (simulado): el documento no salió");
    }
    this.submits.push(meta);
    this.sentXml.push(signedXml);
    const result = await this.mock.submit(signedXml, meta);
    if (this.loseAnswers > 0) {
      this.loseAnswers -= 1;
      throw new EInvoiceTransportError("timeout esperando la respuesta de la DIAN (simulado)");
    }
    return result;
  }
  async poll(trackId: string): Promise<EInvoiceResult> {
    this.polls.push(trackId);
    return this.mock.poll(trackId);
  }
  sentFor(cufe: string): EInvoiceSubmitMeta[] {
    return this.submits.filter((m) => m.cufe === cufe);
  }
}

/** A file store whose next `failPuts` writes fail (the crash between the submit and the store). */
class FlakyStore extends MemoryFileStore {
  failPuts = 0;
  /** Every PDF write fails (Task 19 fix round 2: the graphic representation cannot be kept). */
  failPdf = false;
  override async put(path: string, body: ReadableStream | Buffer, contentType: string): Promise<void> {
    if (this.failPdf && path.endsWith(".pdf")) throw new Error("almacenamiento de PDF no disponible (simulado)");
    if (this.failPuts > 0) {
      this.failPuts -= 1;
      throw new Error("almacenamiento no disponible (simulado)");
    }
    return super.put(path, body, contentType);
  }
}

interface SubmissionRow {
  id: string; invoice_id: string; status: string; round: number; attempts: number; polls: number; track_id: string | null; run_id: string | null;
  cufe: string | null; errors: string[]; last_error: string | null; xml_path: string | null; response_path: string | null; pdf_path: string | null;
}

let h: Harness;
let dian: ScriptedDian;
let store: FlakyStore;
let namespace = 0;
const secrets = new InMemorySecretStore();

beforeAll(async () => {
  h = await invoicingHarness();
  // The workflow's steps run processes through the app's registry, as the dispatch workflow's consumers do.
  loadModules(appRegistry, MODULES);
  await h.sql`update kernel.companies set tax_id = '900373115' where id = ${h.companyId}`;
  const saved = await h.runStepUp("invoicing.settings.update", {
    softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: "900373115",
    issuerTaxResponsibilities: ["O-13"], issuerDepartmentCode: "11", issuerMunicipalityCode: "11001",
  });
  // The answer carries what was saved, the DIAN software fields too.
  expect(saved).toMatchObject({ softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: "900373115", testSetId: null, issuerTaxResponsibilities: ["O-13"], issuerTaxScheme: "01", issuerDepartmentCode: "11", issuerMunicipalityCode: "11001" });
  const { buffer, password } = generateTestCertP12();
  await saveCertificate(secrets, h.companyId, buffer, password);
  await secrets.set(softwarePinSecret(h.companyId), "75315");
  setSecretStore(secrets);
}, 300_000);

beforeEach(() => {
  dian = new ScriptedDian(`t17-${process.pid}-${++namespace}`);
  setEInvoiceTransport(dian);
  store = new FlakyStore();
  setFileStore(store);
});

afterAll(async () => {
  setEInvoiceTransport(undefined);
  setSecretStore(undefined);
  setFileStore(undefined);
  await h.cleanup();
});

const issue = async () => {
  const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 2 }, { productId: h.servicio, qty: 1 }] });
  return h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
};
const submissionOf = async (invoiceId: string) =>
  (await h.sql<SubmissionRow[]>`select * from invoicing.einvoice_submissions where invoice_id = ${invoiceId}`)[0];
const dianStatus = async (invoiceId: string) => (await h.sql<{ dian_status: string }[]>`select dian_status from invoicing.invoices where id = ${invoiceId}`)[0]!.dian_status;
const eventsOf = async (invoiceId: string, event: string) =>
  h.sql<{ payload: Record<string, unknown>; chain_id: string }[]>`select payload, chain_id from kernel.outbox where company_id = ${h.companyId} and event = ${event} and payload->>'invoiceId' = ${invoiceId}`;

/** Waits until the invoice's submission reaches a final status, waking the workflow's backoff sleeps as they come. */
async function settle(invoiceId: string, statuses: string[] = FINAL): Promise<SubmissionRow> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const s = await submissionOf(invoiceId);
    if (s && statuses.includes(s.status)) return s;
    if (Date.now() > deadline) throw new Error(`submission of ${invoiceId} did not settle: ${JSON.stringify(s)}`);
    if (s?.run_id) await getRun(s.run_id).wakeUp().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Waits for the end of the run of the invoice's submission (its last step, the PDF, comes after the verdict). */
async function runEnded(invoiceId: string): Promise<SubmissionRow> {
  const s = await submissionOf(invoiceId);
  await getRun(s!.run_id!).returnValue.catch(() => undefined);
  return (await submissionOf(invoiceId))!;
}

/** Hands the issued event of `invoiceId` to invoicing's consumer once more (a redelivery of the outbox row). */
async function redeliverIssued(invoiceId: string): Promise<void> {
  const [row] = await h.issuedEvent(invoiceId);
  const consumer = consumers.for("invoicing.invoice.issued").find((c) => c.moduleId === "invoicing")!;
  await consumer.fn(buildConsumerContext(h.sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: h.companyId, chainId: row!.chain_id }, registry), row!.payload);
}

describe("e-invoice workflow on the mock DIAN", () => {
  it("accepted: one submission, signed with the company's certificate, sent once; the XML and the ApplicationResponse stored; dian_status accepted and invoicing.invoice.accepted emitted on the issue's chain", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    await settle(invoice.id);
    // The PDF is the run's last step, after the verdict: the run's end is waited for.
    const s = await runEnded(invoice.id);
    expect(s).toMatchObject({
      status: "accepted", round: 1, attempts: 1, polls: 0, cufe: invoice.cufe, track_id: mockTrackId(invoice.cufe!), errors: [],
      // Task 19: the accepted invoice's PDF is kept once next to its XML.
      pdf_path: `einvoice/${h.companyId}/${invoice.id}/envio-1/factura-${invoice.number}.pdf`,
    });
    expect(await dianStatus(invoice.id)).toBe("accepted");
    expect(dian.sentFor(invoice.cufe!)).toEqual([{ cufe: invoice.cufe, documentNumber: invoice.number, issuerNit: "900373115" }]);

    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain(`<cbc:ID>${invoice.number}</cbc:ID>`);
    expect(xml).toContain(invoice.cufe!);
    expect(verifySignedInvoice(xml).valid).toBe(true);
    expect(new TextDecoder().decode(await store.get(s.response_path!))).toContain("SIMULADO");
    // The PDF: the graphic representation with the CUFE, the resolution legend and (habilitación) the test notice.
    const pdf = Buffer.from(await store.get(s.pdf_path!));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const text = pdfText(pdf);
    expect(text).toContain(invoice.cufe!.slice(0, 40));
    expect(text).toContain("18760000001");
    expect(text).toContain(invoice.number!);
    // Stored once: the step run again answers the same file, and the path can never be replaced.
    const again = await buildConsumerContext(h.sql, { companyId: h.companyId, chainId: "00000000-0000-7000-8000-000000000019" }, registry)
      .runProcess("invoicing.einvoice_submission.store_pdf", { id: s.id });
    expect(again).toEqual({ id: s.id, pdfPath: s.pdf_path, stored: false });
    await expect(h.sql`update invoicing.einvoice_submissions set pdf_path = 'otro.pdf' where id = ${s.id}`).rejects.toThrow(/einvoice_pdf_stored/);

    const [issued] = await h.issuedEvent(invoice.id);
    const accepted = await eventsOf(invoice.id, "invoicing.invoice.accepted");
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ chain_id: issued!.chain_id, payload: { invoiceId: invoice.id, number: invoice.number, cufe: invoice.cufe, trackId: s.track_id } });
    // The issued invoice stays frozen: only its DIAN status moved.
    const consult = await h.run<{ einvoice: { status: string; errors: string[] } | null; number: string }>(h.admin, "invoicing.invoice.consult", { id: invoice.id });
    expect(consult).toMatchObject({ number: invoice.number, einvoice: { status: "accepted", errors: [] } });
  });

  it("rejected: the DIAN's errors are stored on the submission and read through the published view (the invoice page); dian_status rejected and invoicing.invoice.rejected emitted", async () => {
    dian.verdict = "rejected";
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "rejected", errors: ["Rechazo simulado: validación de la DIAN fallida"] });
    expect(s.xml_path).not.toBeNull();
    expect(await dianStatus(invoice.id)).toBe("rejected");
    const consult = await h.run<{ einvoice: { status: string; errors: string[] } }>(h.admin, "invoicing.invoice.consult", { id: invoice.id });
    expect(consult.einvoice).toMatchObject({ status: "rejected", errors: ["Rechazo simulado: validación de la DIAN fallida"] });
    const [viewRow] = await h.sql.begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(h.admin.claims)}, true), set_config('role', 'authenticated', true)`;
      return tx<{ errors: string[]; status: string }[]>`select status, errors from invoicing.v_einvoice_submissions where invoice_id = ${invoice.id}`;
    });
    expect(viewRow).toEqual({ status: "rejected", errors: ["Rechazo simulado: validación de la DIAN fallida"] });
    expect(await eventsOf(invoice.id, "invoicing.invoice.rejected")).toHaveLength(1);
    expect(await eventsOf(invoice.id, "invoicing.invoice.accepted")).toHaveLength(0);
  });

  it("pending: polled by trackId with backoff until accepted, never sent again", async () => {
    dian = new ScriptedDian(`t17-${process.pid}-${++namespace}`, 3);
    dian.verdict = "pending";
    setEInvoiceTransport(dian);
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "accepted", attempts: 1, polls: 3 });
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(dian.polls).toEqual([s.track_id, s.track_id, s.track_id]);
  });

  it("a timeout after the submit reached the DIAN: the retry polls by trackId and NEVER submits again", async () => {
    dian.loseAnswers = 1;
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "accepted", attempts: 1, track_id: mockTrackId(invoice.cufe!) });
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(dian.polls).toEqual([mockTrackId(invoice.cufe!)]);
  });

  it("a file store failing (keeping the signed XML before the send) is retried: the document is sent once and both files are kept", async () => {
    store.failPuts = 2;
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s.status).toBe("accepted");
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(new TextDecoder().decode(await store.get(s.xml_path!))).toBe(dian.sentXml[0]);
    expect(store.files.has(s.response_path!)).toBe(true);
  });

  it("a send that never reached the DIAN (connection refused) is sent again: ONE document at the DIAN, no false rejection; dian_status stays Sin enviar until the DIAN answers", async () => {
    dian.failBeforeSend = 2;
    const invoice = await issue();
    const atSend: string[] = [];
    dian.onSend = async () => void atSend.push(await dianStatus(invoice.id));
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    const trackId = mockTrackId(invoice.cufe!);
    expect(s).toMatchObject({ status: "accepted", attempts: 3, track_id: trackId });
    expect(dian.tries).toBe(3);
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    // Before each send again, the DIAN was asked for the earlier one: not received.
    expect(dian.polls).toEqual([trackId, trackId]);
    expect(atSend).toEqual(["draft", "draft", "draft"]);
    expect(await eventsOf(invoice.id, "invoicing.invoice.rejected")).toHaveLength(0);
    expect(await eventsOf(invoice.id, "invoicing.invoice.accepted")).toHaveLength(1);
    expect(new TextDecoder().decode(await store.get(s.xml_path!))).toBe(dian.sentXml[0]);
  });

  it("a lost answer the transport cannot trace (no trackId before the answer) stops as submission_in_doubt, never sent twice", async () => {
    dian.unknownTrackId = true;
    dian.loseAnswers = 1;
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "failed", attempts: 1 });
    expect(s.last_error).toMatch(/submission_in_doubt/);
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
  });

  it("a redelivered invoicing.invoice.issued creates ONE submission and ONE sending, also while the first run is in flight", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    await redeliverIssued(invoice.id);
    await redeliverIssued(invoice.id);
    const s = await settle(invoice.id);
    await redeliverIssued(invoice.id);
    expect(s.status).toBe("accepted");
    expect((await h.sql`select id from invoicing.einvoice_submissions where invoice_id = ${invoice.id}`).length).toBe(1);
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(await eventsOf(invoice.id, "invoicing.invoice.accepted")).toHaveLength(1);
  });

  it("two runs started for the same submission (a start retried after its answer was lost): one claims it and sends, the other exits without sending", async () => {
    const invoice = await issue();
    const ctx = buildConsumerContext(h.sql, { companyId: h.companyId, chainId: (await h.issuedEvent(invoice.id))[0]!.chain_id }, registry);
    const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", { invoiceId: invoice.id })) as { submissionId: string; start: boolean };
    const args = { companyId: h.companyId, invoiceId: invoice.id, submissionId: requested.submissionId, chainId: ctx.chainId };
    const [a, b] = await Promise.all([start(einvoiceSubmission, [args]), start(einvoiceSubmission, [args])]);
    const outcomes = (await Promise.all([a.returnValue, b.returnValue])).map((o) => o.status).sort();
    expect(outcomes).toEqual(["accepted", "not_owner"]);
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(await eventsOf(invoice.id, "invoicing.invoice.accepted")).toHaveLength(1);
  });

  it("the poll limit ends the run with a FatalError (status failed, dian_status stays submitted); «Reintentar envío» polls the same trackId again, never resubmits", async () => {
    dian = new ScriptedDian(`t17-${process.pid}-${++namespace}`, 4);
    dian.verdict = "pending";
    setEInvoiceTransport(dian);
    const invoice = await issue();
    // Run by hand with a limit of 2 polls (the consumer's run would use the default limit).
    const ctx = buildConsumerContext(h.sql, { companyId: h.companyId, chainId: (await h.issuedEvent(invoice.id))[0]!.chain_id }, registry);
    const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", { invoiceId: invoice.id })) as { submissionId: string; start: boolean };
    expect(requested.start).toBe(true);
    const run = await start(einvoiceSubmission, [{ companyId: h.companyId, invoiceId: invoice.id, submissionId: requested.submissionId, chainId: ctx.chainId, maxPolls: 2 }]);
    const outcome = run.returnValue.then(() => "returned", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    const failed = await settle(invoice.id);
    expect(await outcome).toMatch(/poll_limit/);
    expect(failed).toMatchObject({ status: "failed", attempts: 1, polls: 2 });
    expect(failed.last_error).toMatch(/poll_limit/);
    expect(await dianStatus(invoice.id)).toBe("submitted");
    // The signed XML was kept before it was sent.
    expect(new TextDecoder().decode(await store.get(failed.xml_path!))).toBe(dian.sentXml[0]);

    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id });
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id, ["accepted", "rejected"]);
    expect(s).toMatchObject({ status: "accepted", round: 1, attempts: 1, polls: 4, track_id: failed.track_id, xml_path: failed.xml_path });
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect(await dianStatus(invoice.id)).toBe("accepted");
    // The file kept is the document the DIAN validated, byte for byte: the resumed run did not sign it again.
    expect(new TextDecoder().decode(await store.get(s.xml_path!))).toBe(dian.sentXml[0]);
  });

  it("«Reintentar envío» of a rejected invoice re-sends the SAME number and CUFE: unchanged it is rejected again; corrected (the customer's data) it is validated again and accepted; dian_status rejected → submitted → accepted", async () => {
    dian.verdict = "rejected";
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    expect((await settle(invoice.id)).status).toBe("rejected");

    // Unchanged: the same document, the same rejection (the DIAN validates the same content the same way).
    dian.verdict = "accepted";
    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id });
    expect(await h.drain()).toEqual([]);
    const again = await settle(invoice.id, ["accepted", "rejected"]);
    expect(again).toMatchObject({ status: "rejected", round: 2 });

    // Corrected: the customer's e-invoicing e-mail fixed in core; the invoice itself (number, CUFE, amounts) is frozen.
    await h.run(h.admin, "core.party.update", { id: h.partyId, invoiceEmail: "facturacion@cliente.example" });
    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id });
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id, ["accepted", "rejected"]);
    expect(s).toMatchObject({ status: "accepted", round: 3, cufe: invoice.cufe, errors: [] });
    expect(dian.sentFor(invoice.cufe!).map((m) => m.documentNumber)).toEqual([invoice.number, invoice.number, invoice.number]);
    const [row] = await h.sql<{ number: string; cufe: string; dian_status: string }[]>`select number, cufe, dian_status from invoicing.invoices where id = ${invoice.id}`;
    expect(row).toEqual({ number: invoice.number, cufe: invoice.cufe, dian_status: "accepted" });
    const trail = await h.sql<{ before: string | null; after: string }[]>`
      select diff->'dian_status'->>'old' as before, diff->'dian_status'->>'new' as after from kernel.audit_log
      where row_id = ${invoice.id} and entity = 'invoicing.invoices' and action = 'update' and diff ? 'dian_status' order by occurred_at, id`;
    expect(trail.map((t) => `${t.before}→${t.after}`)).toEqual(["draft→submitted", "submitted→rejected", "rejected→submitted", "submitted→rejected", "rejected→submitted", "submitted→accepted"]);
  });

  it("«Reintentar envío» is refused for an accepted invoice and while a sending is in flight; invoicing.invoice.dian_result runs only from events", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    await settle(invoice.id);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id }));
    expect(refused?.code).toBe("invalid_state");
    expect(refused?.message).toMatch(/einvoice_accepted/);
    const fromUi = await h.refusal(h.run(h.admin, "invoicing.invoice.dian_result", { id: invoice.id, submissionId: (await submissionOf(invoice.id))!.id, runId: "x", status: "rejected", errors: [], xmlPath: "x" }));
    expect(fromUi?.code).toBe("forbidden");
  });

  it("dian_status moves only forward: an accepted invoice cannot go back, a Borrador is never sent", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    await settle(invoice.id);
    await expect(h.sql`update invoicing.invoices set dian_status = 'submitted' where id = ${invoice.id}`).rejects.toThrow(/no pasa de accepted a submitted/);
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 1 }] });
    await expect(h.sql`update invoicing.invoices set dian_status = 'submitted' where id = ${draft.id}`).rejects.toThrow(/Borrador no se envía/);
  });

  it("without the certificate the run fails visibly (certificate not configured), nothing is sent; without the software registered nothing is started (not_configured)", async () => {
    await secrets.delete(`dian/${h.companyId}/certificate`);
    try {
      const invoice = await issue();
      expect(await h.drain()).toEqual([]);
      const s = await settle(invoice.id);
      expect(s).toMatchObject({ status: "failed", attempts: 0 });
      expect(s.last_error).toMatch(/credentials not configured/i);
      expect(await dianStatus(invoice.id)).toBe("draft");
      expect(dian.submits).toEqual([]);
    } finally {
      const { buffer, password } = generateTestCertP12();
      await saveCertificate(secrets, h.companyId, buffer, password);
    }
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    try {
      const invoice = await issue();
      expect(await h.drain()).toEqual([]);
      const s = await submissionOf(invoice.id);
      expect(s).toMatchObject({ status: "not_configured", run_id: null });
      expect(s!.last_error).toMatch(/software/i);
      // Registered afterwards, «Reintentar envío» sends it.
      await h.sql`update invoicing.settings set software_id = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0' where company_id = ${h.companyId}`;
      await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id });
      expect(await h.drain()).toEqual([]);
      expect((await settle(invoice.id, ["accepted", "rejected", "failed"])).status).toBe("accepted");
    } finally {
      await h.sql`update invoicing.settings set software_id = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0' where company_id = ${h.companyId}`;
    }
  });
});

describe("the transport serves the company's DIAN environment (Task 19)", () => {
  it("a company in producción is never sent through a mock or habilitación transport: the run fails with einvoice_environment_mismatch before anything is sent", async () => {
    await h.sql`update invoicing.settings set software_id = coalesce(software_id, '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0'), certificate_uploaded_at = coalesce(certificate_uploaded_at, now()), software_pin_set_at = coalesce(software_pin_set_at, now()), dian_defaults_confirmed = true, dian_checklist_version = ${DIAN_CHECKLIST_VERSION}, dian_environment = 'produccion' where company_id = ${h.companyId}`;
    try {
      const invoice = await issue();
      expect(await h.drain()).toEqual([]);
      const s = await settle(invoice.id);
      expect(s).toMatchObject({ status: "failed", attempts: 0, pdf_path: null });
      expect(s.last_error).toMatch(/einvoice_environment_mismatch/);
      expect(dian.submits).toEqual([]);
      expect(await dianStatus(invoice.id)).toBe("draft");
    } finally {
      await h.sql`update invoicing.settings set dian_environment = 'habilitacion' where company_id = ${h.companyId}`;
    }
  });

  it("a PDF that cannot be kept leaves the accepted document accepted (the run ends accepted, no pdf_path, nothing sent again)", async () => {
    store.failPdf = true;
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    expect(await settle(invoice.id)).toMatchObject({ status: "accepted" });
    const ended = await runEnded(invoice.id);
    expect(ended).toMatchObject({ status: "accepted", pdf_path: null, attempts: 1 });
    expect(await dianStatus(invoice.id)).toBe("accepted");
    expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
    expect([...store.files.keys()].some((k) => k.endsWith(".pdf"))).toBe(false);
  }, 90_000);

  it("a rejected document keeps no PDF (only an accepted one does)", async () => {
    const invoice = await issue();
    dian.verdict = "rejected";
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "rejected", pdf_path: null });
    expect(await h.refusal(buildConsumerContext(h.sql, { companyId: h.companyId, chainId: "00000000-0000-7000-8000-000000000019" }, registry)
      .runProcess("invoicing.einvoice_submission.store_pdf", { id: s.id }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/einvoice_not_accepted/) });
  });
});

describe("the document is the invoice as issued", () => {
  /** Issues an invoice whose submission waits (no software registered), then registers the software back. */
  async function issueWaiting(make: () => Promise<InvoiceOut> = issue): Promise<InvoiceOut> {
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    try {
      const invoice = await make();
      expect(await h.drain()).toEqual([]);
      expect((await submissionOf(invoice.id))!.status).toBe("not_configured");
      return invoice;
    } finally {
      await h.sql`update invoicing.settings set software_id = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0' where company_id = ${h.companyId}`;
    }
  }
  const resubmit = async (invoiceId: string) => {
    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    return settle(invoiceId, ["accepted", "rejected", "failed"]);
  };

  it("a product's IVA changed after the issue does not change the document: it is sent with the frozen amounts and the same CUFE", async () => {
    const invoice = await issueWaiting();
    // The service line was taxed at 19 % (the café at 5 %); today the service is exento.
    await h.run(h.admin, "core.product.update", { id: h.servicio, ivaRate: "0" });
    try {
      const s = await resubmit(invoice.id);
      expect(s).toMatchObject({ status: "accepted", cufe: invoice.cufe });
      const xml = new TextDecoder().decode(await store.get(s.xml_path!));
      const [frozen] = await h.sql<{ tax_total: string; total: string }[]>`select tax_total::text, total::text from invoicing.invoices where id = ${invoice.id}`;
      expect(xml).toContain(`<cbc:TaxInclusiveAmount currencyID="COP">${Number(frozen!.total).toFixed(2)}</cbc:TaxInclusiveAmount>`);
      expect(xml).toContain("<cbc:Percent>19.00</cbc:Percent>");
      expect(xml).not.toContain("<cbc:Percent>0.00</cbc:Percent>");
    } finally {
      await h.run(h.admin, "core.product.update", { id: h.servicio, ivaRate: "19" });
    }
  });

  it("a frozen invoice whose stored amounts do not add up is refused (document_changed), nothing is sent", async () => {
    const invoice = await issueWaiting();
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoice_lines set iva = iva + 1 where invoice_id = ${invoice.id} and line_no = 1`;
    });
    const s = await resubmit(invoice.id);
    expect(s.status).toBe("failed");
    expect(s.last_error).toMatch(/document_changed/);
    expect(dian.submits).toEqual([]);
  });

  it("a document that would get another CUFE (the resolution's technical key changed) is refused (cufe_changed), nothing is sent", async () => {
    const invoice = await issueWaiting();
    // The key lives in core.document_resolution_keys (Task 19 fix round 2), one row per resolution.
    const where = () => h.sql`company_id = ${h.companyId} and document_type = 'invoice' and resolution_number = ${h.resolution.number}`;
    const key = (await h.sql<{ key: string }[]>`select technical_key as key from core.document_resolution_keys where ${where()}`)[0]!.key;
    await h.sql`update core.document_resolution_keys set technical_key = 'otra-clave' where ${where()}`;
    try {
      const s = await resubmit(invoice.id);
      expect(s.status).toBe("failed");
      expect(s.last_error).toMatch(/cufe_changed/);
      expect(dian.submits).toEqual([]);
    } finally {
      await h.sql`update core.document_resolution_keys set technical_key = ${key} where ${where()}`;
    }
  });

  it("an invoice issued under a resolution later renewed is still built and sent with the key of ITS resolution (Task 19 fix round 2)", async () => {
    const invoice = await issueWaiting();
    const renewed = { number: "18760000099", from: 990000000, to: 990009999, validFrom: `${h.year}-01-01`, validTo: `${h.year + 1}-12-31`, technicalKey: "tk-resolucion-renovada" };
    const original = { number: h.resolution.number, from: h.resolution.from, to: h.resolution.to, validFrom: h.resolution.validFrom, validTo: h.resolution.validTo, technicalKey: h.resolution.technicalKey };
    await h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "SETP", resolution: renewed });
    try {
      const s = await resubmit(invoice.id);
      expect(s).toMatchObject({ status: "accepted", cufe: invoice.cufe });
    } finally {
      await h.runStepUp("core.document_sequence.register", { documentType: "invoice", prefix: "SETP", resolution: original });
    }
  });

  it("an invoice in foreign currency is sent in its currency with its TRM (Task 18), with the CUFE «Emitir» computed (parity)", async () => {
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, currency: "USD", exchangeRate: 4100, lines: [{ productId: h.servicio, qty: 1, unitPrice: 25 }] });
    const invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(await h.drain()).toEqual([]);
    const s = await settle(invoice.id);
    expect(s).toMatchObject({ status: "accepted", cufe: invoice.cufe, attempts: 1 });
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    expect(xml).toMatch(/<cac:PaymentExchangeRate>[\s\S]*<cbc:SourceCurrencyCode>USD<\/cbc:SourceCurrencyCode>[\s\S]*<cbc:CalculationRate>4100(\.0+)?<\/cbc:CalculationRate>/);
    expect(xml).toContain('<cbc:PayableAmount currencyID="USD">29.75</cbc:PayableAmount>');
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${invoice.cufe}</cbc:UUID>`);
    expect(verifySignedInvoice(xml).valid).toBe(true);
  });

  it("bulk «Reintentar envío» (invoicing.invoice.resubmit_failed) queues again every issued invoice whose sending stopped, e.g. currency_not_supported before Task 18", async () => {
    const stuck = await issueWaiting();
    const other = await issueWaiting();
    // As Task 17 left them: the run stopped on the currency (a foreign-currency invoice) and on another failure.
    await h.sql`update invoicing.einvoice_submissions set status = 'failed', last_error = 'currency_not_supported: La factura está en USD' where invoice_id = ${stuck.id} and note_id is null`;
    await h.sql`update invoicing.einvoice_submissions set status = 'failed', last_error = 'einvoice_transport: caída' where invoice_id = ${other.id} and note_id is null`;
    // A paid invoice is still a DIAN document to send (fix round 1): the sweep takes it too.
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoices set stage = 'paid', paid_amount = total where id = ${other.id}`;
    });
    const only = await h.run<{ requeued: { invoiceId: string }[] }>(h.admin, "invoicing.invoice.resubmit_failed", { only: "currency_not_supported" });
    expect(only.requeued.map((r) => r.invoiceId)).toEqual([stuck.id]);
    expect(await h.drain()).toEqual([]);
    expect(await settle(stuck.id)).toMatchObject({ status: "accepted", cufe: stuck.cufe });
    expect((await submissionOf(other.id))!.status).toBe("failed");
    // Without the filter: every stopped sending (the earlier tests of this file leave some on purpose), never one already accepted.
    const all = await h.run<{ requeued: { invoiceId: string }[] }>(h.admin, "invoicing.invoice.resubmit_failed", {});
    expect(all.requeued.map((r) => r.invoiceId)).toContain(other.id);
    expect(all.requeued.map((r) => r.invoiceId)).not.toContain(stuck.id);
    expect(await h.drain()).toEqual([]);
    expect(await settle(other.id)).toMatchObject({ status: "accepted" });
  });

  it("«Reintentar envío» resumes a submission whose run is no longer running (a stale run), and is refused while its run still runs", async () => {
    const done = await issue();
    expect(await h.drain()).toEqual([]);
    const finished = await settle(done.id);
    const invoice = await issueWaiting();
    // As if a run claimed it and stopped without recording why (the run's World lost it).
    await h.sql`update invoicing.einvoice_submissions set status = 'processing', run_id = ${finished.run_id} where invoice_id = ${invoice.id}`;
    const s = await resubmit(invoice.id);
    expect(s).toMatchObject({ status: "accepted" });
    expect(s.run_id).not.toBe(finished.run_id);
  });
});

// Task 37 (R37-1, R37-2): the document keeps the DIAN environment it was issued in: its XML, its CUFE, its QR and the transport that sends it
// read the frozen `dian_environment` of the document, never the company's current setting; an issued document without one fails the run.
describe("task 37: the document keeps the DIAN environment it was issued in", () => {
  const SOFTWARE = "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0";
  const setEnvironment = (environment: "habilitacion" | "produccion") => h.sql`update invoicing.settings set software_id = coalesce(software_id, ${SOFTWARE}), certificate_uploaded_at = coalesce(certificate_uploaded_at, now()), software_pin_set_at = coalesce(software_pin_set_at, now()), dian_defaults_confirmed = true, dian_checklist_version = ${DIAN_CHECKLIST_VERSION}, dian_environment = ${environment} where company_id = ${h.companyId}`;
  const frozenOf = async (table: "invoices" | "notes", id: string) => (await h.sql.unsafe(`select dian_environment from invoicing.${table} where id = $1`, [id]) as { dian_environment: string | null }[])[0]!.dian_environment;
  const keptXml = async (kind: "factura" | "nota", number: string) => {
    const key = [...store.files.keys()].filter((k) => k.endsWith(`/${kind}-${number}.xml`)).at(-1);
    return key ? new TextDecoder().decode(await store.get(key)) : null;
  };
  /** An invoice issued while the software is not registered (its submission waits), the software registered back afterwards. */
  async function issueWaiting(): Promise<InvoiceOut> {
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    try {
      const invoice = await issue();
      expect(await h.drain()).toEqual([]);
      expect((await submissionOf(invoice.id))!.status).toBe("not_configured");
      return invoice;
    } finally {
      await h.sql`update invoicing.settings set software_id = ${SOFTWARE} where company_id = ${h.companyId}`;
    }
  }
  const resubmitInvoice = async (invoiceId: string) => {
    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    return settle(invoiceId, ["accepted", "rejected", "failed"]);
  };
  /** The print variables of an issued document as the PDF renders them (the module's resolver, observed). */
  async function printedValues(entity: "invoicing.invoice" | "invoicing.note", recordId: string): Promise<Record<string, string>> {
    const resolver = (entity === "invoicing.invoice" ? invoicing.printVariables!["invoicing.invoice"] : invoicing.printVariables!["invoicing.note"])!;
    const spy = vi.spyOn(resolver, "resolve");
    setExportsStore(new MemoryFileStore());
    try {
      await h.run(h.admin, "kernel.doc_template.print", { entity, recordId });
      expect(spy).toHaveBeenCalled();
      return await (spy.mock.results[0]!.value as Promise<Record<string, string>>);
    } finally {
      spy.mockRestore();
      setExportsStore(undefined);
    }
  }
  const auditsOfDocuments = (since: string) => h.sql<{ n: string }[]>`
    select count(*)::text n from kernel.audit_log where company_id = ${h.companyId} and occurred_at > ${since}::timestamptz
      and entity in ('invoicing.invoice', 'invoicing.note') and diff::text like '%dian_environment%'`;

  it("(a) issued under habilitación, the company moves to producción: the resend names habilitación (ProfileExecutionID 2, same CUFE), its QR is habilitación's and it is sent on the habilitación transport; no document row changes (f)", async () => {
    const invoice = await issueWaiting();
    expect(await frozenOf("invoices", invoice.id)).toBe("habilitacion");
    const [clock] = await h.sql<{ now: string }[]>`select clock_timestamp()::text as now`;
    const now = clock!.now;
    await setEnvironment("produccion");
    try {
      const s = await resubmitInvoice(invoice.id);
      expect(s).toMatchObject({ status: "accepted", cufe: invoice.cufe });
      expect(dian.sentFor(invoice.cufe!)).toHaveLength(1);
      const xml = new TextDecoder().decode(await store.get(s.xml_path!));
      expect(xml).toContain("<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>");
      expect(xml).toContain(`schemeName="CUFE-SHA384">${invoice.cufe}</cbc:UUID>`);
      const values = await printedValues("invoicing.invoice", invoice.id);
      expect(values[FE.qrText]).toBe(`https://catalogo-vpfe-hab.dian.gov.co/document/searchqr?documentkey=${invoice.cufe}`);
      // (f) the company's setting moved and no issued document's environment did (row audit has no dian_environment entry for them).
      expect(await frozenOf("invoices", invoice.id)).toBe("habilitacion");
      expect((await auditsOfDocuments(now))[0]!.n).toBe("0");
      // Positive control: the same switch IS row-audited on the settings (so the zero above is a real absence, not a blind audit).
      const [settingsAudit] = await h.sql<{ n: string }[]>`select count(*)::text n from kernel.audit_log where company_id = ${h.companyId} and occurred_at > ${now}::timestamptz and entity = 'invoicing.settings' and diff::text like '%dian_environment%'`;
      expect(Number(settingsAudit!.n)).toBeGreaterThan(0);
    } finally {
      await setEnvironment("habilitacion");
    }
  }, 90_000);

  it("(b) issued under producción, the company goes back to habilitación: the XML names producción (ProfileExecutionID 1), the QR is producción's and the transport required is producción's (mismatch on the mock, nothing sent)", async () => {
    await setEnvironment("produccion");
    let invoice: InvoiceOut;
    try {
      invoice = await issue();
      expect(await h.drain()).toEqual([]);
      expect(await settle(invoice.id)).toMatchObject({ status: "failed" });
      expect(await frozenOf("invoices", invoice.id)).toBe("produccion");
    } finally {
      await setEnvironment("habilitacion");
    }
    const s = await resubmitInvoice(invoice.id);
    expect(s.status).toBe("failed");
    expect(s.last_error).toMatch(/einvoice_environment_mismatch/);
    expect(dian.submits).toEqual([]);
    const xml = await keptXml("factura", invoice.number!);
    expect(xml).toContain("<cbc:ProfileExecutionID>1</cbc:ProfileExecutionID>");
    const values = await printedValues("invoicing.invoice", invoice.id);
    expect(values[FE.qrText]).toBe(`https://catalogo-vpfe.dian.gov.co/document/searchqr?documentkey=${invoice.cufe}`);
  }, 90_000);

  it("(c) a note follows its own frozen environment the same way", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    expect(await settle(invoice.id)).toMatchObject({ status: "accepted" });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no limit 1`;
    const [numbered] = await h.sql<{ n: string }[]>`select count(*)::text n from core.document_sequences where company_id = ${h.companyId} and document_type = 'credit_note'`;
    if (numbered!.n === "0") await h.runStepUp("core.document_sequence.register", { documentType: "credit_note", prefix: "NC", nextNumber: 1 });
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    let note: { id: string; number: string };
    try {
      const draft = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución parcial del cliente", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
      note = await h.run<{ id: string; number: string }>(h.admin, "invoicing.note.issue", { id: draft.id });
      expect(await h.drain()).toEqual([]);
    } finally {
      await h.sql`update invoicing.settings set software_id = ${SOFTWARE} where company_id = ${h.companyId}`;
    }
    expect(await frozenOf("notes", note.id)).toBe("habilitacion");
    await setEnvironment("produccion");
    try {
      await h.run(h.admin, "invoicing.note.resubmit", { id: note.id });
      expect(await h.drain()).toEqual([]);
      const deadline = Date.now() + 45_000;
      let s: SubmissionRow | undefined;
      for (;;) {
        s = (await h.sql<SubmissionRow[]>`select * from invoicing.einvoice_submissions where note_id = ${note.id}`)[0];
        if (s && ["accepted", "rejected", "failed"].includes(s.status)) break;
        if (Date.now() > deadline) throw new Error("note submission did not settle");
        if (s?.run_id) await getRun(s.run_id).wakeUp().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(s!.status).toBe("accepted");
      const xml = new TextDecoder().decode(await store.get(s!.xml_path!));
      expect(xml).toContain("<cbc:ProfileExecutionID>2</cbc:ProfileExecutionID>");
      const values = await printedValues("invoicing.note", note.id);
      expect(values[FE.qrText]).toMatch(/^https:\/\/catalogo-vpfe-hab\.dian\.gov\.co\/document\/searchqr\?documentkey=/);
    } finally {
      await setEnvironment("habilitacion");
    }
  }, 120_000);

  it("(d) an issued invoice whose frozen environment is null (impossible by the check, forced here) fails the run document_environment_missing and never reads the company's", async () => {
    const invoice = await issueWaiting();
    await h.sql`alter table invoicing.invoices drop constraint invoices_issued_environment`;
    try {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = null where id = ${invoice.id}`;
      });
      const s = await resubmitInvoice(invoice.id);
      expect(s.status).toBe("failed");
      expect(s.last_error).toMatch(/document_environment_missing/);
      expect(dian.submits).toEqual([]);
      // The PDF of an issued document says the same instead of reading the company's.
      const error = await h.refusal(h.run(h.admin, "kernel.doc_template.print", { entity: "invoicing.invoice", recordId: invoice.id }));
      expect(error).toBeTruthy();
      expect(`${(error as Error).message} ${JSON.stringify((error as { details?: unknown }).details ?? "")}`).toMatch(/document_environment_missing/);
    } finally {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = 'habilitacion' where id = ${invoice.id}`;
      });
      await h.sql`alter table invoicing.invoices add constraint invoices_issued_environment check (stage = 'draft' or dian_environment is not null)`;
    }
  }, 90_000);

  it("(d2) transportFor refuses an issued document without its frozen environment (document_environment_missing) and serves the frozen one otherwise", async () => {
    const invoice = await issueWaiting();
    const args = { companyId: h.companyId, invoiceId: invoice.id, submissionId: "00000000-0000-7000-8000-000000000001", chainId: "00000000-0000-7000-8000-000000000002" };
    // The company says producción; the document says habilitación: the mock serves habilitación, so the transport is the installed one.
    await setEnvironment("produccion");
    try {
      expect((await transportFor(args)).name).toBe("scripted-mock");
    } finally {
      await setEnvironment("habilitacion");
    }
    await h.sql`alter table invoicing.invoices drop constraint invoices_issued_environment`;
    try {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = null where id = ${invoice.id}`;
      });
      await expect(transportFor(args)).rejects.toThrow(/document_environment_missing/);
    } finally {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = 'habilitacion' where id = ${invoice.id}`;
      });
      await h.sql`alter table invoicing.invoices add constraint invoices_issued_environment check (stage = 'draft' or dian_environment is not null)`;
    }
  }, 90_000);

  it("(d3) a note's «Emitir» refuses document_environment_missing when its issued invoice has no frozen environment, never reading the company's", async () => {
    const invoice = await issue();
    expect(await h.drain()).toEqual([]);
    expect(await settle(invoice.id)).toMatchObject({ status: "accepted" });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no limit 1`;
    const [numbered] = await h.sql<{ n: string }[]>`select count(*)::text n from core.document_sequences where company_id = ${h.companyId} and document_type = 'credit_note'`;
    if (numbered!.n === "0") await h.runStepUp("core.document_sequence.register", { documentType: "credit_note", prefix: "NC", nextNumber: 1 });
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución parcial del cliente", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    await h.sql`alter table invoicing.invoices drop constraint invoices_issued_environment`;
    try {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = null where id = ${invoice.id}`;
      });
      expect(await h.refusal(h.run(h.admin, "invoicing.note.issue", { id: draft.id }))).toMatchObject({ code: "invalid_state", message: expect.stringMatching(/document_environment_missing/) });
      const [row] = await h.sql<{ stage: string }[]>`select stage from invoicing.notes where id = ${draft.id}`;
      expect(row!.stage).toBe("draft");
    } finally {
      await h.sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`update invoicing.invoices set dian_environment = 'habilitacion' where id = ${invoice.id}`;
      });
      await h.sql`alter table invoicing.invoices add constraint invoices_issued_environment check (stage = 'draft' or dian_environment is not null)`;
    }
  }, 90_000);

  it("(e) a Borrador prints without a frozen environment (it has none yet): no error, no QR", async () => {
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.servicio, qty: 1 }] });
    expect(await frozenOf("invoices", draft.id)).toBeNull();
    const values = await printedValues("invoicing.invoice", draft.id);
    for (const name of [FE.qr, FE.qrText, FE.code]) expect(values[name]).toBe("");
  });
});
