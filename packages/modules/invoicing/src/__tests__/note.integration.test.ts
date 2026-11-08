import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRun } from "workflow/api";
import { InMemorySecretStore, MockEInvoiceTransport, type MockScenario } from "@erp/infra";
import { loadModules, registry as appRegistry, setEInvoiceTransport, setFileStore, setSecretStore } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { einvoicePack, saveCertificate, verifySignedInvoice } from "@erp/loc-co/einvoice";
import { generateTestCertP12 } from "../../../../localization/co/src/__tests__/helpers/test-cert";
import { DIAN_CHECKLIST_VERSION, invoicingHarness, MODULES, type Harness, type InvoiceOut } from "./helpers";
import noteAnnulmentRule from "../rules/note-annulment-issued.json" with { type: "json" };
import noteCreditRule from "../rules/note-credit-issued.json" with { type: "json" };
import noteDebitRule from "../rules/note-debit-issued.json" with { type: "json" };

// Credit and debit notes, and the annulment of an issued invoice by its credit note (plan 2B Task 18; design §8, §8.1; OD-7 of §22.25), on
// the demo chart with the real posting engine and the e-invoice workflow on the MOCK DIAN only (no habilitación credentials exist):
//   - a note corrects an invoice the DIAN accepted, never another note; a credit never exceeds what is left of the invoice; a note posts in
//     its own month (an invoice of a closed month is not touched);
//   - Anular (step-up) issues exactly one FULL credit note of annulment (concept 2, CustomizationID 20, the invoice's CUFE); the invoice stays
//     issued until the DIAN accepts the note, then it is voided naming the note (one statement), its number kept; sales gets back what it
//     invoiced (invoiced_qty) and the open-invoice and credit-exposure views drop it; invoicing.invoice.voided is never emitted;
//   - an export invoice (USD, foreign buyer) is annulled by a note of type 02 in USD with the invoice's TRM.

interface NoteOut { id: string; kind: string; number: string | null; cude: string | null; invoiceId: string; concept: string; annulment: boolean; stage: string; dianStatus: string; issueDate: string; total: number; subtotal: number; taxTotal: number }
interface SubmissionRow { id: string; invoice_id: string; note_id: string | null; status: string; round: number; attempts: number; track_id: string | null; run_id: string | null; cufe: string | null; xml_path: string | null; last_error: string | null }

const FINAL = ["accepted", "rejected", "failed", "not_configured"];

let h: Harness;
let store: MemoryFileStore;
let verdict: MockScenario = "accepted";
let namespace = 0;
let categoryId: string;
const secrets = new InMemorySecretStore();

beforeAll(async () => {
  h = await invoicingHarness();
  loadModules(appRegistry, MODULES);
  await h.sql`update kernel.companies set tax_id = '900373115' where id = ${h.companyId}`;
  await h.runStepUp("invoicing.settings.update", {
    softwareId: "56f2ae4e-9812-4fad-9255-08fcfcd5ccb0", softwareProviderTaxId: "900373115",
    issuerTaxResponsibilities: ["O-13"], issuerDepartmentCode: "11", issuerMunicipalityCode: "11001",
  });
  // The notes' own numbering (core.next_document_number, credit_note / debit_note): a plain sequence row (prefix and next number). The DIAN
  // authorizes no range for notes and a note has no technical key (its CUDE takes the software PIN): no resolution (fix round 1).
  for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
    await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, ${type}, ${prefix}, 1)`;
  }
  // Revenue by category (the invoice's rule): both products in one category mapped to 413505, so 413595 (the role's default) is never hit.
  categoryId = (await h.run<{ id: string }>(h.admin, "core.category.create", { name: "Mostrador", ivaRate: "5", otherTaxes: [], defaultUom: "94" })).id;
  await h.sql`update core.products set category_id = ${categoryId} where id = any(${[h.cafe, h.servicio]}::uuid[])`;
  const [account] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '413505'`;
  await h.runStepUp("accounting.account_role_mapping.update", { mappings: [{ role: "revenue", dimension: `category:${categoryId}`, accountId: account!.id }] });
  const { buffer, password } = generateTestCertP12();
  await saveCertificate(secrets, h.companyId, buffer, password);
  await secrets.set(`dian/${h.companyId}/software-pin`, "75315");
  setSecretStore(secrets);
}, 300_000);

beforeEach(() => {
  verdict = "accepted";
  setEInvoiceTransport(new MockEInvoiceTransport({ namespace: `t18-${process.pid}-${++namespace}`, pendingPolls: 2, scenario: () => verdict }));
  store = new MemoryFileStore();
  setFileStore(store);
});

afterAll(async () => {
  setEInvoiceTransport(undefined);
  setSecretStore(undefined);
  setFileStore(undefined);
  await h.cleanup();
});

const submissionOf = async (target: { invoiceId: string } | { noteId: string }) =>
  "noteId" in target
    ? (await h.sql<SubmissionRow[]>`select * from invoicing.einvoice_submissions where note_id = ${target.noteId}`)[0]
    : (await h.sql<SubmissionRow[]>`select * from invoicing.einvoice_submissions where invoice_id = ${target.invoiceId} and note_id is null`)[0];

/** Waits until the submission reaches a final status, waking the workflow's backoff sleeps as they come. */
async function settle(target: { invoiceId: string } | { noteId: string }, statuses: string[] = FINAL): Promise<SubmissionRow> {
  const deadline = Date.now() + 45_000;
  for (;;) {
    const s = await submissionOf(target);
    if (s && statuses.includes(s.status)) return s;
    if (Date.now() > deadline) throw new Error(`submission ${JSON.stringify(target)} did not settle: ${JSON.stringify(s)}`);
    if (s?.run_id) await getRun(s.run_id).wakeUp().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const invoiceRow = async (id: string) =>
  (await h.sql<{ stage: string; status: string; number: string; dian_status: string; annulment_note_id: string | null; credited_amount: string; debited_amount: string; issue_date: string }[]>`
    select stage, status, number, dian_status, annulment_note_id, credited_amount::text, debited_amount::text, issue_date::text from invoicing.invoices where id = ${id}`)[0]!;
const noteEvents = (noteId: string) => h.sql<{ id: string }[]>`select id from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.note.issued' and payload->>'noteId' = ${noteId}`;

/** An invoice of the given lines issued and accepted by the (mock) DIAN. */
async function acceptedInvoice(lines: { productId: string; qty: number; unitPrice?: number }[] = [{ productId: h.cafe, qty: 2 }, { productId: h.servicio, qty: 1 }], extra: Record<string, unknown> = {}) {
  const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines, ...extra });
  const invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
  expect(await h.drain()).toEqual([]);
  expect(await settle({ invoiceId: invoice.id })).toMatchObject({ status: "accepted" });
  return invoice;
}
const linesOfInvoice = (invoiceId: string) => h.sql<{ id: string; qty: string; base: string }[]>`select id, qty::text, base::text from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;

const creditNote = async (invoiceId: string, lines: { invoiceLineId: string; qty: number; unitPrice?: number }[], concept = "1") =>
  h.run<NoteOut>(h.admin, "invoicing.note.create", { invoiceId, kind: "credit", concept, reason: "Devolución parcial del cliente", lines });

/** Accounts of an entry with their debit and credit, by account code. */
async function entryOf(event: { id: string }) {
  const [entry] = await h.entriesFor(event.id);
  const lines = await h.linesOf(entry!.id);
  const byCode: Record<string, { debit: number; credit: number }> = {};
  for (const l of lines) {
    const at = (byCode[l.code] ??= { debit: 0, credit: 0 });
    at.debit = Math.round((at.debit + Number(l.debit)) * 100) / 100;
    at.credit = Math.round((at.credit + Number(l.credit)) * 100) / 100;
  }
  return { entry: entry!, byCode };
}

describe("credit and debit notes of an accepted invoice", () => {
  it("a partial credit note: Borrador, «Emitir» numbers it NC, posts the reversal of its lines (Dr revenue and IVA / Cr receivable), and is sent to the DIAN with its CUDE", async () => {
    const invoice = await acceptedInvoice();
    const [cafeLine] = await linesOfInvoice(invoice.id);
    const draft = await creditNote(invoice.id, [{ invoiceLineId: cafeLine!.id, qty: 1 }]);
    expect(draft).toMatchObject({ kind: "credit", stage: "draft", number: null, concept: "1", annulment: false, invoiceId: invoice.id });
    // 1 × 28.500 (the café's net price) at the invoice line's IVA 5 %: 1.425 of IVA.
    expect([draft.subtotal, draft.taxTotal, draft.total]).toEqual([28500, 1425, 29925]);
    const issued = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: draft.id });
    expect(issued).toMatchObject({ stage: "issued", status: "posted", number: "NC1", issueDate: h.today });
    expect((await invoiceRow(invoice.id)).credited_amount).toBe("29925.0000");

    const [event] = await noteEvents(issued.id);
    const { entry, byCode } = await entryOf(event!);
    expect(entry).toMatchObject({ status: "posted", date: h.today, total_debit: "29925.0000", total_credit: "29925.0000" });
    expect(byCode["130505"]).toEqual({ debit: 0, credit: 29925 });
    expect(byCode["240802"]).toEqual({ debit: 1425, credit: 0 });
    // A partial credit is a sales return by its concept (sales_returns, note_reason:1 → the role's 417505), never the revenue account.
    expect(byCode["417505"]).toEqual({ debit: 28500, credit: 0 });
    expect(Object.keys(byCode).sort()).toEqual(["130505", "240802", "417505"]);

    expect(await h.drain()).toEqual([]);
    const s = await settle({ noteId: issued.id });
    expect(s).toMatchObject({ status: "accepted", invoice_id: invoice.id, note_id: issued.id, attempts: 1 });
    const [note] = await h.sql<{ cude: string; dian_status: string }[]>`select cude, dian_status from invoicing.notes where id = ${issued.id}`;
    expect(note).toMatchObject({ dian_status: "accepted" });
    expect(note!.cude).toMatch(/^[0-9a-f]{96}$/);
    expect(s.cufe).toBe(note!.cude);
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain("<CreditNote");
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toContain("<cbc:ResponseCode>1</cbc:ResponseCode>");
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUDE-SHA384">${note!.cude}</cbc:UUID>`);
    expect(xml).toContain(invoice.cufe!);
    expect(s.xml_path).toContain(`/notas/${issued.id}/envio-1/nota-NC1.xml`);
    expect(verifySignedInvoice(xml).valid).toBe(true);
    // A partial note does not void the invoice nor change what sales counts as invoiced.
    expect((await invoiceRow(invoice.id)).stage).toBe("issued");
  });

  it("a credit above what is left of the invoice is refused, at creation and again at «Emitir» under the invoice's lock", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 2 }]);
    const [line] = await linesOfInvoice(invoice.id);
    const over = await h.refusal(creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 3 }]));
    expect(over?.message).toMatch(/^invalid_note_line/);
    const first = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    const issuedFirst = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: first.id });
    const second = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    // The invoice-level backstop at «Emitir», under the lock: what is left of the invoice is less than the draft (credited elsewhere meanwhile).
    const [{ total }] = await h.sql<[{ total: string }]>`select total::text from invoicing.invoices where id = ${invoice.id}`;
    await h.sql`update invoicing.invoices set credited_amount = ${total} where id = ${invoice.id}`;
    try {
      const refused = await h.refusal(h.run(h.admin, "invoicing.note.issue", { id: second.id }));
      expect(refused?.message).toMatch(/^credit_exceeds_invoice/);
      expect((await h.sql`select stage, number from invoicing.notes where id = ${second.id}`)[0]).toEqual({ stage: "draft", number: null });
    } finally {
      await h.sql`update invoicing.invoices set credited_amount = ${issuedFirst.total} where id = ${invoice.id}`;
    }
    // The refused «Emitir» drew no number: the next credit note issued is the following consecutive.
    const next = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: second.id });
    expect(next.number).toBe(`NC${Number(issuedFirst.number!.slice(2)) + 1}`);
  });

  it("an invoice line is credited at most once in quantity and in value, counting issued and draft notes; one note names a line once", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 2 }, { productId: h.servicio, qty: 1 }]);
    const [lineA, lineB] = await linesOfInvoice(invoice.id);
    // Two notes each crediting line A fully: the second is refused, whether the first is a Borrador or issued.
    const full = await creditNote(invoice.id, [{ invoiceLineId: lineA!.id, qty: 2 }]);
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: lineA!.id, qty: 2 }])))?.message).toMatch(/^invalid_note_line/);
    await h.run(h.admin, "invoicing.note.issue", { id: full.id });
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: lineA!.id, qty: 1 }])))?.message).toMatch(/^invalid_note_line/);
    // In value: one unit of line B at its full value (a price adjustment) leaves nothing of it; another unit is refused.
    const priced = await creditNote(invoice.id, [{ invoiceLineId: lineB!.id, qty: 1, unitPrice: Number(lineB!.base) }], "4");
    expect(priced.subtotal).toBe(Number(lineB!.base));
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: lineB!.id, qty: 1, unitPrice: 1 }])))?.message).toMatch(/^invalid_note_line/);
    // Deleting the Borrador frees what it held.
    await h.run(h.admin, "invoicing.note.delete", { id: priced.id });
    // Two lines of one note on the same invoice line are refused.
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: lineB!.id, qty: 0.5 }, { invoiceLineId: lineB!.id, qty: 0.5 }])))?.message).toMatch(/^invalid_note_line/);
    expect(await creditNote(invoice.id, [{ invoiceLineId: lineB!.id, qty: 1 }])).toMatchObject({ stage: "draft" });
  });

  it("concurrency: two credits of the same invoice line at once give one note; two drafts that fit, issued at once, both issue with their own numbers", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 2 }]);
    const [line] = await linesOfInvoice(invoice.id);
    const created = await Promise.allSettled([
      creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 2 }]),
      creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 2 }]),
    ]);
    expect(created.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(String((created.find((r) => r.status === "rejected") as PromiseRejectedResult).reason?.message)).toMatch(/^invalid_note_line/);
    await h.run(h.admin, "invoicing.note.delete", { id: (created.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<NoteOut>).value.id });

    const a = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    const b = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    const issued = await Promise.all([a, b].map((n) => h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: n.id })));
    expect(new Set(issued.map((n) => n.number)).size).toBe(2);
    expect(Number((await invoiceRow(invoice.id)).credited_amount)).toBe(issued[0]!.total + issued[1]!.total);
  });

  it("the database backstops: a note line names a line of the note's invoice; the invoice is never credited above its total plus its debits", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    const other = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    const [line] = await linesOfInvoice(invoice.id);
    const [otherLine] = await linesOfInvoice(other.id);
    const draft = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    await expect(h.sql`update invoicing.note_lines set invoice_line_id = ${otherLine!.id} where note_id = ${draft.id}`).rejects.toThrow(/no es de la factura de la nota/);
    await expect(h.sql`update invoicing.invoices set credited_amount = total + debited_amount + 1 where id = ${invoice.id}`).rejects.toThrow(/invoices_credited_within_total/);
  });

  it("a note referencing a note is refused (Oficio DIAN 129 of 2023); an invoice the DIAN has not accepted takes no note", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 2 }]);
    const [line] = await linesOfInvoice(invoice.id);
    const note = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
    const refused = await h.refusal(creditNote(note.id, [{ invoiceLineId: line!.id, qty: 1 }]));
    expect(refused?.message).toMatch(/^note_references_note/);

    // Never sent (no software when it was issued) and rejected.
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    const waiting = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: (await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 1 }] })).id });
    const [waitingLine] = await linesOfInvoice(waiting.id);
    expect((await h.refusal(creditNote(waiting.id, [{ invoiceLineId: waitingLine!.id, qty: 1 }])))?.message).toMatch(/^invoice_not_sent/);
    try {
      expect(await h.drain()).toEqual([]);
      expect((await h.refusal(creditNote(waiting.id, [{ invoiceLineId: waitingLine!.id, qty: 1 }])))?.message).toMatch(/^einvoice_not_configured/);
      // A sending that stopped (failed): «Reintentar envío» first.
      await h.sql`update invoicing.einvoice_submissions set status = 'failed', last_error = 'einvoice_transport: caída' where invoice_id = ${waiting.id} and note_id is null`;
      expect((await h.refusal(creditNote(waiting.id, [{ invoiceLineId: waitingLine!.id, qty: 1 }])))?.message).toMatch(/^invoice_send_failed/);
    } finally {
      await h.sql`update invoicing.settings set software_id = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0' where company_id = ${h.companyId}`;
    }

    verdict = "rejected";
    const rejected = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: (await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 1 }] })).id });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ invoiceId: rejected.id })).toMatchObject({ status: "rejected" });
    const [rejectedLine] = await linesOfInvoice(rejected.id);
    expect((await h.refusal(creditNote(rejected.id, [{ invoiceLineId: rejectedLine!.id, qty: 1 }])))?.message).toMatch(/^invoice_rejected/);
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: rejected.id, reason: "x" })))?.message).toMatch(/^invoice_rejected/);
    // The annulment concept is only Anular's; a concept outside the table is refused.
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }], "2")))?.message).toMatch(/^annulment_by_void/);
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }], "9")))?.message).toMatch(/^invalid_note_concept/);
  });

  it("a note dated in a later month than its invoice posts in its own month; the invoice's closed month is not touched (accounting §5.5)", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 2 }]);
    // The invoice of the last day of the previous month (as if issued on 30 October and noted on 1 November): its date and its entry moved
    // there (replica mode: an issued invoice and a posted entry are frozen), and that month closed.
    const [prev] = await h.sql<{ d: string; period: number }[]>`select (date_trunc('month', ${h.today}::date) - interval '1 day')::date::text as d, extract(month from (date_trunc('month', ${h.today}::date) - interval '1 day'))::int as period`;
    const [issuedEvent] = await h.issuedEvent(invoice.id);
    const [invoiceEntry] = await h.entriesFor(issuedEvent!.id);
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoices set issue_date = ${prev!.d}, due_date = ${prev!.d} where id = ${invoice.id}`;
      await tx`update accounting.entries set date = ${prev!.d}, period_id = (select id from accounting.periods where company_id = ${h.companyId} and ${prev!.d}::date between starts_on and ends_on) where id = ${invoiceEntry!.id}`;
    });
    await h.sql`update accounting.periods set status = 'closed' where company_id = ${h.companyId} and ${prev!.d}::date between starts_on and ends_on`;
    try {
      const [line] = await linesOfInvoice(invoice.id);
      const note = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: (await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }])).id });
      expect(note.issueDate).toBe(h.today);
      const [event] = await noteEvents(note.id);
      const [entry] = await h.sql<{ date: string; period_start: string; status: string }[]>`
        select e.date::text, p.starts_on::text as period_start, e.status from accounting.entries e join accounting.periods p on p.id = e.period_id where e.source_event_id = ${event!.id}`;
      expect(entry).toMatchObject({ date: h.today, status: "posted" });
      expect(entry!.period_start).toBe(`${h.today.slice(0, 7)}-01`);
      expect((await h.sql`select date::text from accounting.entries where id = ${invoiceEntry!.id}`)[0]).toEqual({ date: prev!.d });
    } finally {
      await h.sql`update accounting.periods set status = 'open' where company_id = ${h.companyId} and ${prev!.d}::date between starts_on and ends_on`;
    }
  });

  it("a debit note (Intereses) numbers ND, posts Dr receivable / Cr revenue and IVA, and adds to what the invoice owes", async () => {
    const invoice = await acceptedInvoice([{ productId: h.servicio, qty: 1 }]);
    const [line] = await linesOfInvoice(invoice.id);
    const draft = await h.run<NoteOut>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "debit", concept: "1", reason: "Intereses de mora", lines: [{ invoiceLineId: line!.id, qty: 1, unitPrice: 10000 }] });
    const note = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: draft.id });
    expect(note).toMatchObject({ kind: "debit", number: "ND1", total: 11900 });
    expect((await invoiceRow(invoice.id)).debited_amount).toBe("11900.0000");
    const { byCode } = await entryOf((await noteEvents(note.id))[0]!);
    expect(byCode["130505"]).toEqual({ debit: 11900, credit: 0 });
    expect(byCode["240801"]).toEqual({ debit: 0, credit: 1900 });
    // A debit note is revenue by the line's category, as the invoice's.
    expect(byCode["413505"]).toEqual({ debit: 0, credit: 10000 });
    expect(Object.keys(byCode).sort()).toEqual(["130505", "240801", "413505"]);
    const [open] = await h.sql<{ open_company: string }[]>`select open_company::text from invoicing.v_open_invoices where invoice_id = ${invoice.id}`;
    expect(Number(open!.open_company)).toBe(59500 + 11900);
    expect(await h.drain()).toEqual([]);
    const s = await settle({ noteId: note.id });
    expect(s.status).toBe("accepted");
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain("<DebitNote");
    expect(xml).toContain("<cbc:CustomizationID>30</cbc:CustomizationID>");
    // An issued note is not voided.
    expect((await h.refusal(h.run(h.admin, "invoicing.note.void", { id: note.id })))?.message).toMatch(/^note_not_voidable/);
  });
});

describe("Anular an issued invoice (OD-7): the full credit note of annulment", () => {
  it("the annulment process runs only nested in Anular of the invoice, never on its own", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    const refused = await h.refusal(h.run(h.admin, "invoicing.note.issue_annulment", { invoiceId: invoice.id, reason: "x" }));
    expect(refused?.code).toBe("forbidden");
    expect(await h.sql`select 1 from invoicing.notes where invoice_id = ${invoice.id}`).toEqual([]);
  });

  it("voiding an accepted invoice creates exactly one annulment note and the invoice stays issued until the DIAN accepts it (deferred Task 16 test, mock transport)", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    // The DIAN answers the note «pending» twice before accepting it.
    verdict = "pending";
    const voided = await h.runStepUp<{ id: string; deleted: boolean; annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" });
    expect(voided).toMatchObject({ id: invoice.id, deleted: false });
    const notes = await h.sql<{ id: string; annulment: boolean; concept: string; stage: string; number: string }[]>`select id, annulment, concept, stage, number from invoicing.notes where invoice_id = ${invoice.id}`;
    expect(notes).toEqual([{ id: voided.annulmentNoteId, annulment: true, concept: "2", stage: "issued", number: expect.stringMatching(/^NC\d+$/) }]);
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "issued", annulment_note_id: null, credited_amount: "29925.0000" });
    expect(await h.drain()).toEqual([]);
    // On its way (the mock answers pending): still issued.
    expect((await invoiceRow(invoice.id)).stage).toBe("issued");
    // A second Anular is refused: the invoice already has its note.
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "otra vez" })))?.message).toMatch(/^invoice_has_note/);
    // While its annulment is pending, the invoice takes no other note, credit or debit.
    const [line] = await linesOfInvoice(invoice.id);
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }])))?.message).toMatch(/^invoice_has_note/);
    expect((await h.refusal(h.run(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "debit", concept: "1", reason: "Intereses", lines: [{ invoiceLineId: line!.id, qty: 1, unitPrice: 100 }] })))?.message).toMatch(/^invoice_has_note/);
    expect(await settle({ noteId: voided.annulmentNoteId })).toMatchObject({ status: "accepted" });
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "voided", annulment_note_id: voided.annulmentNoteId, number: invoice.number, status: "posted" });
    expect(await h.sql`select 1 from invoicing.notes where invoice_id = ${invoice.id}`).toHaveLength(1);
    // Accepted: the invoice is voided and takes no note.
    expect((await h.refusal(creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }])))?.message).toMatch(/^invoice_voided/);
  });

  it("an annulment the DIAN rejects leaves the invoice issued with its one note; «Reintentar envío» of the note, once accepted, voids it", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    verdict = "rejected";
    const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ noteId: voided.annulmentNoteId })).toMatchObject({ status: "rejected", round: 1 });
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "issued", annulment_note_id: null });
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "otra vez" })))?.message).toMatch(/^invoice_has_note/);
    // Corrected where the DIAN pointed (the customer's e-mail, in Terceros): the same note, number and CUDE inputs, sent again.
    verdict = "accepted";
    await h.run(h.admin, "core.party.update", { id: h.partyId, invoiceEmail: "facturas@andina.example" });
    await h.run(h.admin, "invoicing.note.resubmit", { id: voided.annulmentNoteId });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ noteId: voided.annulmentNoteId })).toMatchObject({ status: "accepted", round: 2 });
    expect(await h.drain()).toEqual([]);
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "voided", annulment_note_id: voided.annulmentNoteId });
    expect(await h.sql`select 1 from invoicing.notes where invoice_id = ${invoice.id}`).toHaveLength(1);
  });

  it("the DIAN accepting the annulment of an invoice that is no longer issued (paid meanwhile) is an error, never a silent skip", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    verdict = "pending";
    const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" });
    // Paid while the DIAN answers (Task 21 refuses this payment; here forced to prove the verdict step does not skip it).
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoices set stage = 'paid', paid_amount = total where id = ${invoice.id}`;
    });
    expect(await h.drain()).toEqual([]);
    const s = await settle({ noteId: voided.annulmentNoteId });
    expect(s.status).toBe("failed");
    expect(s.last_error).toMatch(/annulment_invoice_not_issued/);
    expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "paid", annulment_note_id: null });
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.invoice.annulled' and payload->>'invoiceId' = ${invoice.id}`).toEqual([]);
  });

  it("without a credit-note numbering row, Anular is refused with what to do and nothing changes; notes need no DIAN resolution", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    const [row] = await h.sql<{ prefix: string; next_number: string }[]>`
      delete from core.document_sequences where company_id = ${h.companyId} and document_type = 'credit_note' returning prefix, next_number::text`;
    try {
      const refused = await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" }));
      expect(refused?.message).toMatch(/^no_sequence: La empresa no tiene numeración de notas crédito/);
      expect(await h.sql`select 1 from invoicing.notes where invoice_id = ${invoice.id}`).toEqual([]);
      expect(await invoiceRow(invoice.id)).toMatchObject({ stage: "issued", credited_amount: "0.0000" });
      const [line] = await linesOfInvoice(invoice.id);
      const draft = await creditNote(invoice.id, [{ invoiceLineId: line!.id, qty: 1 }]);
      expect((await h.refusal(h.run(h.admin, "invoicing.note.issue", { id: draft.id })))?.message).toMatch(/^no_sequence/);
      await h.run(h.admin, "invoicing.note.delete", { id: draft.id });
    } finally {
      await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, 'credit_note', ${row!.prefix}, ${row!.next_number})`;
    }
    // The plain row numbers the note: no resolution, nothing of a resolution on the note.
    const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Factura errada" });
    const [note] = await h.sql<{ number: string; resolution: unknown }[]>`select number, resolution from invoicing.notes where id = ${voided.annulmentNoteId}`;
    expect(note).toEqual({ number: `NC${row!.next_number}`, resolution: null });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ noteId: voided.annulmentNoteId })).toMatchObject({ status: "accepted" });
  });

  it("end to end on the demo chart: a shipped sale invoiced, accepted and annulled: one balanced reversal in the note's month, invoiced_qty given back, the open items drop the invoice, no invoicing.invoice.voided", async () => {
    const order = await h.confirmedOrder([{ productId: h.cafe, qty: 4 }]);
    const delivery = await h.shipDelivery(order.id);
    expect(await h.drain()).toEqual([]);
    const { invoices } = await h.run<{ invoices: InvoiceOut[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: invoices[0]!.id });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ invoiceId: invoice.id })).toMatchObject({ status: "accepted" });
    const invoiced = () => h.sql<{ invoiced_qty: string }[]>`select invoiced_qty::text from sales.delivery_lines where delivery_id = ${delivery.id}`;
    expect(await invoiced()).toEqual([{ invoiced_qty: "4.0000" }]);
    expect(await h.sql`select 1 from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toHaveLength(1);

    const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "El cliente devolvió todo" });
    const { entry, byCode } = await entryOf((await noteEvents(voided.annulmentNoteId))[0]!);
    const { byCode: original } = await entryOf((await h.issuedEvent(invoice.id))[0]!);
    // The reversal: balanced, in the note's month, the receivable and the IVA the mirror of the invoice's, the revenue the same amount.
    expect(entry).toMatchObject({ status: "posted", date: h.today });
    expect(entry.total_debit).toBe(entry.total_credit);
    expect(byCode["130505"]).toEqual({ debit: 0, credit: original["130505"]!.debit });
    expect(byCode["240802"]).toEqual({ debit: original["240802"]!.credit, credit: 0 });
    // Per account: the annulment is the exact mirror of the invoice, so every account it touched returns to zero; the revenue goes back
    // through the category's account (413505), never the role's default 413595 nor sales returns.
    expect(Object.keys(byCode).sort()).toEqual(Object.keys(original).sort());
    for (const [code, a] of Object.entries(original)) expect(byCode[code]).toEqual({ debit: a.credit, credit: a.debit });
    expect(original["413505"]!.credit).toBeGreaterThan(0);
    expect(byCode["413595"]).toBeUndefined();
    expect(byCode["417505"]).toBeUndefined();

    expect(await h.drain()).toEqual([]);
    expect(await settle({ noteId: voided.annulmentNoteId })).toMatchObject({ status: "accepted" });
    expect(await h.drain()).toEqual([]);
    expect((await invoiceRow(invoice.id)).stage).toBe("voided");
    // Sales recomputed invoiced_qty from invoicing.invoice.annulled; what shipped is pending to invoice again.
    expect(await invoiced()).toEqual([{ invoiced_qty: "0.0000" }]);
    expect(await h.sql`select 1 from invoicing.v_pending_to_invoice where delivery_id = ${delivery.id}`).toHaveLength(1);
    expect(await h.sql`select 1 from invoicing.v_open_invoices where invoice_id = ${invoice.id}`).toEqual([]);
    expect(await h.sql`select 1 from invoicing.v_order_invoiced where order_id = ${order.id}`).toEqual([]);
    expect(await h.sql`select 1 from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.invoice.voided'`).toEqual([]);
    const [annulled] = await h.sql<{ payload: { invoiceId: string; noteId: string; deliveryIds: string[] } }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.invoice.annulled' and payload->>'invoiceId' = ${invoice.id}`;
    expect(annulled!.payload).toMatchObject({ noteId: voided.annulmentNoteId, deliveryIds: [delivery.id] });
    // The annulment note's XML: concept 2, CustomizationID 20, the invoice's CUFE in its BillingReference.
    const s = await submissionOf({ noteId: voided.annulmentNoteId });
    const xml = new TextDecoder().decode(await store.get(s!.xml_path!));
    expect(xml).toContain("<cbc:ResponseCode>2</cbc:ResponseCode>");
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toMatch(new RegExp(`<cac:BillingReference>[\\s\\S]*<cbc:ID>${invoice.number}</cbc:ID>[\\s\\S]*${invoice.cufe}`));
  });

  it("concurrency: two Anular of the same invoice at once give one annulment note; the other is refused", async () => {
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 1 }]);
    const results = await Promise.allSettled([
      h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "A" }),
      h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "B" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/^invoice_has_note/);
    expect(await h.sql`select 1 from invoicing.notes where invoice_id = ${invoice.id} and annulment`).toHaveLength(1);
  });

  it("an export invoice in USD to a buyer abroad is sent as an export and annulled by a credit note of type 02 in USD with the invoice's TRM", async () => {
    const buyer = (await h.run<{ id: string }>(h.admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "50", documentNumber: "987654321", legalName: "Coffee Importers LLC", taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
      countryCode: "US", addressLine: "100 Main St, Seattle WA", invoiceEmail: "ap@importers.example",
    })).id;
    await h.markReady(buyer);
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: buyer, currency: "USD", exchangeRate: 4123.4567, lines: [{ productId: h.cafe, qty: 100, unitPrice: 12.5 }] });
    const invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(await h.drain()).toEqual([]);
    const sent = await settle({ invoiceId: invoice.id });
    expect(sent).toMatchObject({ status: "accepted", cufe: invoice.cufe });
    const invoiceXml = new TextDecoder().decode(await store.get(sent.xml_path!));
    expect(invoiceXml).toContain("<cbc:InvoiceTypeCode>02</cbc:InvoiceTypeCode>");
    expect(invoiceXml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    // The export is frozen at «Emitir» (customer country ≠ the company's then): a later edit of the buyer's country changes nothing of it.
    expect((await h.sql`select is_export from invoicing.invoices where id = ${invoice.id}`)[0]).toEqual({ is_export: true });
    await h.sql`update core.parties set country_code = 'CO', department_code = '11', municipality_code = '11001' where id = ${buyer}`;

    const voided = await h.runStepUp<{ annulmentNoteId: string }>("invoicing.invoice.void", { id: invoice.id, reason: "Exportación cancelada" });
    expect(await h.drain()).toEqual([]);
    const s = await settle({ noteId: voided.annulmentNoteId });
    expect(s.status).toBe("accepted");
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain("<cbc:CreditNoteTypeCode>02</cbc:CreditNoteTypeCode>");
    expect(xml).toContain("<cbc:DocumentCurrencyCode>USD</cbc:DocumentCurrencyCode>");
    expect(xml).toMatch(/<cac:PaymentExchangeRate>[\s\S]*<cbc:SourceCurrencyCode>USD<\/cbc:SourceCurrencyCode>[\s\S]*<cbc:CalculationRate>4123\.4567<\/cbc:CalculationRate>/);
    expect(xml).toContain("<cbc:CustomizationID>20</cbc:CustomizationID>");
    expect(xml).toContain(invoice.cufe!);
    expect(xml).not.toContain('currencyID="COP"');
    expect((await invoiceRow(invoice.id)).stage).toBe("voided");
  });
});

describe("a foreign buyer's identification", () => {
  const foreignBuyer = async (documentNumber: string) => {
    const id = (await h.run<{ id: string }>(h.admin, "core.party.create", {
      kind: ["customer"], personType: "1", documentType: "42", documentNumber, legalName: `Importadora ${documentNumber}`, taxResponsibilities: ["R-99-PN"], taxScheme: "ZZ",
      countryCode: "US", addressLine: "100 Main St, Seattle WA", invoiceEmail: "ap@importers.example",
    })).id;
    await h.markReady(id);
    return id;
  };
  const usdInvoice = (partyId: string) =>
    h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId, currency: "USD", exchangeRate: 4000, lines: [{ productId: h.cafe, qty: 10, unitPrice: 12.5 }] });

  it("keeps the letters of a foreign document (type 42) in the XML and the CUFE, with parity between «Emitir» and the sending", async () => {
    const buyer = await foreignBuyer("AB123456");
    const invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: (await usdInvoice(buyer)).id });
    expect(await h.drain()).toEqual([]);
    const s = await settle({ invoiceId: invoice.id });
    expect(s).toMatchObject({ status: "accepted", cufe: invoice.cufe });
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain(">AB123456</cbc:CompanyID>");
    expect(xml).toContain(`<cbc:UUID schemeID="2" schemeName="CUFE-SHA384">${invoice.cufe}</cbc:UUID>`);
  });

  it("an FX invoice issued before the fix (its CUFE over the digits only, Task 16's computation) is still sent: the digits-only document keeps its CUFE", async () => {
    const buyer = await foreignBuyer("CD654321");
    await h.sql`update invoicing.settings set software_id = null where company_id = ${h.companyId}`;
    let invoice: InvoiceOut;
    try {
      invoice = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: (await usdInvoice(buyer)).id });
      expect(await h.drain()).toEqual([]);
    } finally {
      await h.sql`update invoicing.settings set software_id = '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0' where company_id = ${h.companyId}`;
    }
    // Its CUFE as Task 16 computed it: the customer's id reduced to its digits.
    const [row] = await h.sql<{ number: string; issue_date: string; issue_time: string; subtotal: string; total: string }[]>`
      select number, issue_date::text, issue_time, subtotal::text, total::text from invoicing.invoices where id = ${invoice.id}`;
    const taxes = await h.sql<{ family: "IVA" | "INC" | "OTHER"; code: string; rate: string | null; base: string; amount: string }[]>`
      select family, code, rate::text, base::text, amount::text from invoicing.invoice_taxes where invoice_id = ${invoice.id}`;
    const legacy = einvoicePack.invoiceCode({
      number: row!.number, issueDate: row!.issue_date, issueTime: row!.issue_time,
      taxed: { subtotal: Number(row!.subtotal), total: Number(row!.total), taxes: taxes.map((t) => ({ family: t.family, code: t.code, rate: t.rate === null ? null : Number(t.rate), base: Number(t.base), amount: Number(t.amount) })) },
      issuerTaxId: "900373115", customerTaxId: "CD654321", technicalKey: h.resolution.technicalKey, environment: "habilitacion",
    });
    expect(legacy).not.toBe(invoice.cufe);
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoices set cufe = ${legacy} where id = ${invoice.id}`;
      await tx`update invoicing.einvoice_submissions set cufe = ${legacy} where invoice_id = ${invoice.id} and note_id is null`;
    });
    await h.run(h.admin, "invoicing.invoice.resubmit", { id: invoice.id });
    expect(await h.drain()).toEqual([]);
    const s = await settle({ invoiceId: invoice.id });
    expect(s).toMatchObject({ status: "accepted", cufe: legacy });
    const xml = new TextDecoder().decode(await store.get(s.xml_path!));
    expect(xml).toContain(">654321</cbc:CompanyID>");
    expect(xml).toContain(`schemeName="CUFE-SHA384">${legacy}</cbc:UUID>`);
  });
});

describe("the note's posting rules (fix round 1)", () => {
  const RULES = [noteAnnulmentRule, noteCreditRule, noteDebitRule];
  const rules = () => h.sql<{ name: string; template: unknown; is_default: boolean; is_modified: boolean; is_active: boolean }[]>`
    select name, template, is_default, is_modified, is_active from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued' order by name`;

  it("a company has one copy of each of the three note rules (accounting's defaults and invoicing's are the same rules)", async () => {
    expect((await rules()).map((r) => [r.name, r.template])).toEqual(RULES.map((r) => [r.name, r.template]).sort(([a], [b]) => String(a).localeCompare(String(b))));
    await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
    expect(await rules()).toHaveLength(3);
  });

  // Migration 0098 splits the one default rule companies seeded before had, and only an unmodified copy (the 0071 pattern of Task 7).
  it("migration 0098 splits an unmodified old copy into the three rules, leaves a modified one posting with the three disabled, and is a no-op the second time", async () => {
    const migration = readFileSync(new URL("../../../../../supabase/migrations/0098_accounting_note_rules_split.sql", import.meta.url), "utf8");
    const old = { ...noteAnnulmentRule.template, lines: noteAnnulmentRule.template.lines.map((l, i) => (i === 1 ? { ...l, dimension: "note_reason:{{$$.reasonCode}}" } : l)) } as Record<string, unknown>;
    delete old.when;
    const OLD = "Nota crédito o débito de venta";
    // The rules entries point at are parked under another event (inside the rolled-back transaction), never deleted.
    const park = (tx: typeof h.sql, keep: string) =>
      tx`update accounting.posting_rules set event = 'test.parked' where company_id = ${h.companyId} and event = 'invoicing.note.issued' and name <> ${keep}`;
    const seedOld = async (tx: typeof h.sql, modified: boolean) => {
      await park(tx, noteAnnulmentRule.name);
      await tx`update accounting.posting_rules set name = ${OLD}, template = ${tx.json(old as never)}, is_modified = ${modified} where company_id = ${h.companyId} and event = 'invoicing.note.issued'`;
    };
    const ofCompany = (tx: typeof h.sql) => tx<{ name: string; template: unknown; is_default: boolean; is_modified: boolean; is_active: boolean }[]>`
      select name, template, is_default, is_modified, is_active from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued' order by name`;
    const byName = (rows: { name: string }[]) => Object.fromEntries(rows.map((r) => [r.name, r]));
    const rollback = new Error("rollback");
    await h.sql.begin(async (tx) => {
      await seedOld(tx as never, false);
      await tx.unsafe(migration);
      const split = await ofCompany(tx as never);
      expect(split.map((r) => r.name).sort()).toEqual(RULES.map((r) => r.name).sort());
      for (const rule of RULES) expect(byName(split)[rule.name]).toMatchObject({ template: rule.template, is_default: true, is_modified: false, is_active: true });
      await tx.unsafe(migration);
      expect(await ofCompany(tx as never)).toEqual(split);

      await seedOld(tx as never, true);
      await park(tx as never, OLD);
      await tx.unsafe(migration);
      const kept = byName(await ofCompany(tx as never));
      expect(kept[OLD]).toMatchObject({ template: old, is_modified: true, is_active: true });
      for (const rule of RULES) expect(kept[rule.name]).toMatchObject({ template: rule.template, is_modified: true, is_active: false });
      throw rollback;
    }).catch((e: unknown) => { if (e !== rollback) throw e; });
    expect(await rules()).toHaveLength(3);
  });

  // Final review I-1: accounting.posting_rule.sync ran BEFORE 0098 (the new code deployed first, or migrations applied by hand later): the
  // sync added the three rules beside the old copy, 0098's guards skipped everything, and the old rule (no `when`) posted every note again.
  // Migration 0115 and the sync itself now keep exactly one effective set, whichever order they run in. Committed state (a note must post),
  // restored at the end: the company's own three rules come back as they were.
  it("sync before 0098: 0115 and the sync leave exactly one effective set of note rules, and a note posts once (unmodified and modified old copy)", async () => {
    const OLD = "Nota crédito o débito de venta";
    const files = ["0098_accounting_note_rules_split.sql", "0115_accounting_note_rules_retire_combined.sql"]
      .map((f) => readFileSync(new URL(`../../../../../supabase/migrations/${f}`, import.meta.url), "utf8"));
    const migrate = async () => { for (const sql of files) await h.sql.unsafe(sql); };
    const old = { ...noteAnnulmentRule.template, lines: noteAnnulmentRule.template.lines.map((l, i) => (i === 1 ? { ...l, dimension: "note_reason:{{$$.reasonCode}}" } : l)) } as Record<string, unknown>;
    delete old.when;
    const original = await h.sql<{ id: string; is_active: boolean; is_modified: boolean }[]>`
      select id, is_active, is_modified from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued'`;
    expect(original).toHaveLength(3);
    const [model] = await h.sql<{ module: string; journal_id: string; priority: number }[]>`
      select module, journal_id, priority from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued' and name = ${noteAnnulmentRule.name}`;
    const insertOld = (modified: boolean) => h.sql`
      insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default, is_active, is_modified)
      values (${h.companyId}, 'invoicing.note.issued', ${OLD}, ${model!.module}, ${model!.journal_id}, ${h.sql.json(old as never)}, ${model!.priority}, true, true, ${modified})`;
    const park = () => h.sql`update accounting.posting_rules set event = 'test.parked' where company_id = ${h.companyId} and event = 'invoicing.note.issued'`;
    const active = async () => (await h.sql<{ name: string; is_modified: boolean }[]>`
      select name, is_modified from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued' and is_active order by name`).map((r) => r.name);
    const all = () => h.sql<{ name: string; is_active: boolean; is_modified: boolean }[]>`
      select name, is_active, is_modified from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.note.issued' order by name, is_modified`;
    const NEW = RULES.map((r) => r.name).sort();
    const invoice = await acceptedInvoice([{ productId: h.cafe, qty: 4 }]);
    const [cafeLine] = await linesOfInvoice(invoice.id);
    /** One partial credit note of one café, issued: the entries of its event (exactly one, balanced). */
    const noteEntries = async () => {
      const draft = await creditNote(invoice.id, [{ invoiceLineId: cafeLine!.id, qty: 1 }]);
      const issued = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: draft.id });
      expect(await h.drain()).toEqual([]);
      await settle({ noteId: issued.id });
      const [event] = await noteEvents(issued.id);
      return h.entriesFor(event!.id);
    };
    try {
      // 1. The state the review found: the pre-fix sync already added the three beside an UNMODIFIED old copy (four active rules).
      await insertOld(false);
      expect(await active()).toHaveLength(4);
      await migrate();
      await migrate();
      expect(await active()).toEqual(NEW);
      expect((await all()).find((r) => r.name === OLD)).toMatchObject({ is_active: false, is_modified: true });
      // The sync never brings it back.
      await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
      expect(await active()).toEqual(NEW);
      const once = await noteEntries();
      expect(once).toHaveLength(1);
      expect(once[0]).toMatchObject({ status: "posted", total_debit: once[0]!.total_credit });

      // 2. The sync (this code) runs while only the old unmodified copy exists: it installs the three and retires the old one itself; 0098
      //    and 0115 afterwards change nothing.
      await park();
      await insertOld(false);
      await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
      expect(await active()).toEqual(NEW);
      const afterSync = await all();
      await migrate();
      await migrate();
      expect(await all()).toEqual(afterSync);
      expect(await noteEntries()).toHaveLength(1);

      // 3. An old copy the ADMIN MODIFIED, the pre-fix sync's three beside it: it keeps posting, the three are disabled and marked modified.
      await park();
      await insertOld(true);
      for (const rule of RULES) {
        await h.sql`
          insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
          values (${h.companyId}, 'invoicing.note.issued', ${rule.name}, ${model!.module}, ${model!.journal_id}, ${h.sql.json(rule.template as never)}, ${model!.priority}, true)`;
      }
      expect(await active()).toHaveLength(4);
      await migrate();
      await migrate();
      expect(await active()).toEqual([OLD]);
      for (const r of (await all()).filter((x) => x.name !== OLD)) expect(r).toMatchObject({ is_active: false, is_modified: true });
      await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
      expect(await active()).toEqual([OLD]);
      expect(await noteEntries()).toHaveLength(1);

      // 4. The same modified copy when the sync (this code) is the one that installs the three: they arrive disabled.
      await park();
      await insertOld(true);
      await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
      expect(await active()).toEqual([OLD]);
      const synced = await all();
      expect(synced).toHaveLength(4);
      await migrate();
      expect(await all()).toEqual(synced);
    } finally {
      await park();
      for (const r of original) {
        await h.sql`update accounting.posting_rules set event = 'invoicing.note.issued', is_active = ${r.is_active}, is_modified = ${r.is_modified} where id = ${r.id}`;
      }
    }
    expect(await rules()).toHaveLength(3);
  }, 180_000);
});

describe("a note follows its invoice's DIAN environment (Task 19 fix round 2)", () => {
  it("a note of an invoice issued in habilitación is issued in habilitación after the company moved to producción", async () => {
    const invoice = await acceptedInvoice();
    const [cafeLine] = await linesOfInvoice(invoice.id);
    const draft = await creditNote(invoice.id, [{ invoiceLineId: cafeLine!.id, qty: 1 }]);
    await h.sql`update invoicing.settings set software_id = coalesce(software_id, '56f2ae4e-9812-4fad-9255-08fcfcd5ccb0'), certificate_uploaded_at = coalesce(certificate_uploaded_at, now()), software_pin_set_at = coalesce(software_pin_set_at, now()), dian_defaults_confirmed = true, dian_checklist_version = ${DIAN_CHECKLIST_VERSION}, dian_environment = 'produccion' where company_id = ${h.companyId}`;
    try {
      const issued = await h.run<NoteOut>(h.admin, "invoicing.note.issue", { id: draft.id });
      const [row] = await h.sql<{ dian_environment: string }[]>`select dian_environment from invoicing.notes where id = ${issued.id}`;
      expect(row!.dian_environment).toBe("habilitacion");
    } finally {
      await h.sql`update invoicing.settings set dian_environment = 'habilitacion' where company_id = ${h.companyId}`;
    }
    expect(await h.drain()).toEqual([]);
  }, 120_000);

  it("invoicing.invoice.consult answers the INVOICE's submission, never one of its notes", async () => {
    const invoice = await acceptedInvoice();
    const [cafeLine] = await linesOfInvoice(invoice.id);
    const draft = await creditNote(invoice.id, [{ invoiceLineId: cafeLine!.id, qty: 1 }]);
    await h.run(h.admin, "invoicing.note.issue", { id: draft.id });
    expect(await h.drain()).toEqual([]);
    expect(await settle({ noteId: draft.id })).toMatchObject({ status: "accepted" });
    const own = (await submissionOf({ invoiceId: invoice.id }))!;
    // Rewrite the invoice's row so a scan finds the note's first (a new tuple goes after it): the answer is still the invoice's own.
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.einvoice_submissions set attempts = attempts where id = ${own.id}`;
    });
    for (let i = 0; i < 3; i++) {
      const consult = await h.run<{ einvoice: { id: string; note_id: string | null } }>(h.admin, "invoicing.invoice.consult", { id: invoice.id });
      expect(consult.einvoice).toMatchObject({ id: own.id, note_id: null });
    }
  }, 120_000);
});
