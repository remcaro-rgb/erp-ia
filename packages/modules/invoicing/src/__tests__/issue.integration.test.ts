import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../../../accounting/src/rules/fixtures/invoice-issued.json" with { type: "json" };
import { invoicingHarness, type Harness, type InvoiceOut } from "./helpers";

// «Emitir» (plan 2B Task 16, D8, D9, rule 10): one number of the DIAN resolution and one CUFE per invoice, a retry with the same key answers
// the stored result, the customer and products must be invoice_ready (with the reasons), the issued event carries what the 2A rule
// `invoice-issued` reads and posts balanced on the demo chart in the same transaction, a closed period or an exhausted resolution refuses
// the whole issue with nothing written, and Anular follows OD-7.

let h: Harness;
beforeAll(async () => {
  h = await invoicingHarness();
}, 300_000);
afterAll(async () => {
  await h.cleanup();
});

const manual = (lines: { productId: string; qty: number; unitPrice?: number; discountPct?: number }[], extra: Record<string, unknown> = {}) =>
  h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, issueDate: h.day(4, 5), lines, ...extra });
const counter = async () => (await h.sql<{ next_number: string }[]>`select next_number::text from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice'`)[0]!.next_number;
const ownRows = async (invoiceId: string) => ({
  invoice: await h.sql`select number, cufe, stage, status from invoicing.invoices where id = ${invoiceId}`,
  events: await h.sql`select event from kernel.outbox where company_id = ${h.companyId} and payload->>'invoiceId' = ${invoiceId} and event = 'invoicing.invoice.issued'`,
});

describe("invoicing.invoice.issue", () => {
  it("numbers the invoice with the resolution and gives it one CUFE; the issued event posts receivable / revenue (cost center) / IVA balanced, in the same transaction", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 10 }, { productId: h.servicio, qty: 1, unitPrice: 100000, discountPct: 10 }]);
    expect(draft).toMatchObject({ status: "draft", stage: "draft", number: null, cufe: null, origin: "manual", issueDate: h.day(4, 5), dueDate: h.day(4, 5) });
    // 10 × 28.500 at 5 % and 90.000 at 19 %.
    expect(draft).toMatchObject({ subtotal: 375000, taxTotal: 31350, total: 406350 });
    const before = Number(await counter());

    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id, idempotencyKey: "k1" });
    // DIAN: an invoice is dated the day it is generated. The draft's date stays as the service date.
    expect(issued).toMatchObject({ status: "posted", stage: "issued", dianStatus: "draft", number: `SETP${before}`, issueDate: h.today, dueDate: h.today, serviceDate: h.day(4, 5) });
    expect(issued.cufe).toMatch(/^[0-9a-f]{96}$/);
    expect(Number(await counter())).toBe(before + 1);
    const [row] = await h.sql<{ prefix: string; consecutive: string; resolution: Record<string, unknown>; issue_time: string }[]>`
      select prefix, consecutive::text, resolution, issue_time from invoicing.invoices where id = ${draft.id}`;
    expect(row).toMatchObject({ prefix: "SETP", consecutive: String(before) });
    // The resolution as the invoice prints it: never its technical key.
    expect(row!.resolution).toEqual({ number: "18760000001", prefix: "SETP", from: 990000000, to: 990000999, validFrom: h.resolution.validFrom, validTo: h.resolution.validTo });
    expect(row!.issue_time).toMatch(/^\d{2}:\d{2}:\d{2}-05:00$/);

    // The payload carries every key the 2A fixture of invoice-issued has.
    const [event] = await h.issuedEvent(draft.id);
    const payload = event!.payload as typeof fixture & Record<string, unknown>;
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(payload)).toEqual(expect.arrayContaining(keys(fixture)));
    expect(keys(payload.lines[0]!)).toEqual(expect.arrayContaining(keys(fixture.lines[0]!)));
    expect(keys(payload.taxes[0]!)).toEqual(expect.arrayContaining(keys(fixture.taxes[0]!)));
    // Task 34.4 (R34-4): each company amount keeps its field and gains its document twin (*Doc); a COP invoice carries both equal.
    expect(payload).toMatchObject({ number: issued.number, invoiceId: draft.id, date: h.today, dueDate: h.today, totals: { total: 406350, totalDoc: 406350 }, costCenterId: h.costCenterId, currency: "COP", exchangeRate: 1 });
    expect(payload.taxes).toEqual([
      { code: "IVA5", rate: 5, amount: 14250, amountDoc: 14250, base: 285000 },
      { code: "IVA19", rate: 19, amount: 17100, amountDoc: 17100, base: 90000 },
    ]);

    // Posted inline: the entry exists before any dispatch, balanced, revenue with the cost center.
    const [entry] = await h.entriesFor(event!.id);
    expect(entry).toMatchObject({ status: "posted", date: h.today, total_debit: "406350.0000", total_credit: "406350.0000" });
    const lines = await h.linesOf(entry!.id);
    expect(lines.filter((l) => Number(l.debit) > 0).map((l) => [l.code.slice(0, 4), l.debit])).toEqual([["1305", "406350.0000"]]);
    expect(lines.filter((l) => l.code.startsWith("4135")).every((l) => l.cost_center_id === h.costCenterId)).toBe(true);
    expect(lines.filter((l) => l.code.startsWith("4135")).reduce((s, l) => s + Number(l.credit), 0)).toBe(375000);
    expect(lines.filter((l) => l.code.startsWith("2408")).reduce((s, l) => s + Number(l.credit), 0)).toBe(31350);
    expect(await h.drain()).toEqual([]);
    // The accounting consumer never posts it a second time.
    expect(await h.entriesFor(event!.id)).toHaveLength(1);
  });

  it("a retry of «Emitir» with the same key answers the stored result; without it, an issued invoice is refused; no second number or CUFE", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    const first = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id, idempotencyKey: "same" });
    const after = await counter();
    const again = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id, idempotencyKey: "same" });
    expect(again).toEqual(first);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
    expect(refused?.code).toBe("invalid_state");
    expect(refused?.message).toMatch(/^invoice_issued/);
    expect(await counter()).toBe(after);
    expect(await h.issuedEvent(draft.id)).toHaveLength(1);
    const [row] = await h.sql<{ cufe: string }[]>`select cufe from invoicing.invoices where id = ${draft.id}`;
    expect(row!.cufe).toBe(first.cufe);
  });

  it("refuses a customer that is not invoice_ready, with the reasons; a customer who stops being ready before «Emitir» is refused there", async () => {
    const notReady = await h.newCustomer("900123456", "Sin Papeles S.A.S.", false);
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.create", { partyId: notReady, issueDate: h.day(4, 5), lines: [{ productId: h.cafe, qty: 1 }] }));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^not_invoice_ready/);
    expect(refused?.details).toEqual([expect.stringMatching(/^El cliente Sin Papeles S\.A\.S\. no está listo para facturar: .*faltan archivos: .*RUT/)]);

    const later = await h.newCustomer("900765432", "Papeles Vencidos S.A.S.");
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: later, issueDate: h.day(4, 5), lines: [{ productId: h.cafe, qty: 1 }] });
    await h.run(h.admin, "core.party.deactivate", { id: later });
    const before = await counter();
    const atIssue = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
    expect(atIssue?.message).toMatch(/^not_invoice_ready/);
    expect(await counter()).toBe(before);
    expect((await ownRows(draft.id)).invoice).toEqual([{ number: null, cufe: null, stage: "draft", status: "draft" }]);
  });

  it("a closed period refuses the whole issue: no number drawn, no CUFE, no event, the Borrador unchanged", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }], { issueDate: h.day(2, 20) });
    // «Emitir» dates the invoice today: today's period is the one that matters, whatever the draft's date.
    const [period] = await h.sql<{ id: string }[]>`
      update accounting.periods set status = 'closed' where company_id = ${h.companyId} and ${h.today}::date between starts_on and ends_on returning id`;
    expect(period).toBeDefined();
    try {
      const before = await counter();
      const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
      expect(refused?.message).toMatch(/closed_period|period_closed/);
      expect(await counter()).toBe(before);
      expect(await ownRows(draft.id)).toEqual({ invoice: [{ number: null, cufe: null, stage: "draft", status: "draft" }], events: [] });
    } finally {
      await h.sql`update accounting.periods set status = 'open' where id = ${period!.id}`;
    }
    // Once the period is open the same Borrador issues.
    expect((await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id })).stage).toBe("issued");
  });

  it("an exhausted or expired resolution refuses with its data and draws nothing", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    const [seq] = await h.sql<{ id: string; next_number: string }[]>`select id, next_number::text from core.document_sequences where company_id = ${h.companyId} and document_type = 'invoice'`;
    await h.sql`update core.document_sequences set next_number = 990001000 where id = ${seq!.id}`;
    try {
      const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
      expect(refused?.message).toMatch(/^out_of_range: La resolución DIAN 18760000001 \(prefijo SETP, del 990000000 al 990000999/);
      expect((await ownRows(draft.id)).invoice).toEqual([{ number: null, cufe: null, stage: "draft", status: "draft" }]);
    } finally {
      await h.sql`update core.document_sequences set next_number = ${seq!.next_number} where id = ${seq!.id}`;
    }
    await h.sql`update core.document_sequences set resolution = resolution || ${h.sql.json({ validTo: h.day(3, 31) } as never)} where id = ${seq!.id}`;
    try {
      expect((await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id })))?.message).toMatch(/^expired: La resolución DIAN 18760000001 .* vigente del .* al .*-03-31\)/);
    } finally {
      await h.sql`update core.document_sequences set resolution = ${h.sql.json(h.resolution as never)} where id = ${seq!.id}`;
    }
  });

  it("a crédito invoice is due after the days of credit of the Parámetros, counted from the issue date", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }], { paymentForm: "2" });
    expect(draft.dueDate).toBe(h.day(5, 5));
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    const [due] = await h.sql<{ d: string }[]>`select (${h.today}::date + 30)::text as d`;
    expect(issued.dueDate).toBe(due!.d);
  });

  it("a draft dated in the past is numbered and dated today; consecutive numbers never go back in date", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }], { issueDate: h.day(2, 1) });
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(issued).toMatchObject({ issueDate: h.today, serviceDate: h.day(2, 1) });
    const rows = await h.sql<{ issue_date: string }[]>`
      select issue_date::text from invoicing.invoices where company_id = ${h.companyId} and consecutive is not null order by consecutive`;
    const dates = rows.map((r) => r.issue_date);
    expect(dates).toEqual([...dates].sort());
  });

});

describe("invoicing.invoice.update", () => {
  it("an omitted field keeps its value; null clears the notes and the cost center", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }], { notes: "Entregar en portería", costCenterId: h.costCenterId });
    const row = async () => (await h.sql<{ notes: string | null; cost_center_id: string | null }[]>`select notes, cost_center_id from invoicing.invoices where id = ${draft.id}`)[0]!;
    await h.run(h.admin, "invoicing.invoice.update", { id: draft.id, paymentMeans: "42" });
    expect(await row()).toEqual({ notes: "Entregar en portería", cost_center_id: h.costCenterId });
    await h.run(h.admin, "invoicing.invoice.update", { id: draft.id, notes: null, costCenterId: null });
    expect(await row()).toEqual({ notes: null, cost_center_id: null });
  });
});

describe("the CUFE names the customer's tax id", () => {
  it("a customer whose tax id the CUFE cannot carry is refused with a clear error, nothing drawn", async () => {
    const customer = await h.newCustomer("900111222", "Sin NIT Legible S.A.S.");
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: customer, lines: [{ productId: h.cafe, qty: 1 }] });
    await h.sql`update core.parties set document_number = 'SIN-NUMERO' where id = ${customer}`;
    const before = await counter();
    const refused = await h.refusal(h.run(h.admin, "invoicing.invoice.issue", { id: draft.id }));
    expect(refused?.message).toMatch(/^customer_tax_id_missing/);
    expect(await counter()).toBe(before);
  });
});

describe("invoicing.invoice.void (OD-7)", () => {
  it("needs a step-up; a Borrador is deleted with its lines and taxes", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    expect((await h.refusal(h.run(h.admin, "invoicing.invoice.void", { id: draft.id, reason: "Error" })))?.code).toBe("step_up_required");
    expect(await h.runStepUp("invoicing.invoice.void", { id: draft.id, reason: "Error de digitación" })).toEqual({ id: draft.id, deleted: true, annulmentNoteId: null });
    expect(await h.sql`select 1 from invoicing.invoices where id = ${draft.id}`).toEqual([]);
    expect(await h.sql`select 1 from invoicing.invoice_lines where invoice_id = ${draft.id}`).toEqual([]);
    expect(await h.sql`select 1 from invoicing.invoice_taxes where invoice_id = ${draft.id}`).toEqual([]);
  });

  it("an issued invoice is annulled only by a credit note of an invoice the DIAN accepted: one never sent is refused (Task 18), the invoice stays issued; paid or noted invoices are refused first", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    const refused = await h.refusal(h.runStepUp("invoicing.invoice.void", { id: issued.id, reason: "Devolución total" }));
    expect(refused?.code).toBe("invalid_state");
    expect(refused?.message).toMatch(/^invoice_not_sent/);
    expect((await ownRows(issued.id)).invoice).toEqual([{ number: issued.number, cufe: issued.cufe, stage: "issued", status: "posted" }]);

    await h.sql`update invoicing.invoices set paid_amount = 1000 where id = ${issued.id}`;
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: issued.id, reason: "x" })))?.message).toMatch(/^invoice_paid/);
    await h.sql`update invoicing.invoices set paid_amount = 0, credited_amount = 500 where id = ${issued.id}`;
    expect((await h.refusal(h.runStepUp("invoicing.invoice.void", { id: issued.id, reason: "x" })))?.message).toMatch(/^invoice_has_note/);
    await h.sql`update invoicing.invoices set credited_amount = 0 where id = ${issued.id}`;
  });

  it("an issued invoice keeps its number, CUFE, amounts and lines whoever writes", async () => {
    const draft = await manual([{ productId: h.cafe, qty: 1 }]);
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    await expect(h.sql`update invoicing.invoices set total = 1 where id = ${issued.id}`).rejects.toThrow(/Una factura emitida no cambia/);
    await expect(h.sql`update invoicing.invoice_lines set qty = 2 where invoice_id = ${issued.id}`).rejects.toThrow(/no cambian/);
    await expect(h.sql`delete from invoicing.invoices where id = ${issued.id}`).rejects.toThrow(/Solo se elimina una factura en Borrador/);
  });
});

describe("posting rules", () => {
  it("a company seeded before invoicing has the invoice-issued rule once: the sync adds no duplicate", async () => {
    const rules = await h.sql<{ module: string }[]>`select module from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.invoice.issued'`;
    expect(rules).toEqual([{ module: "accounting" }]);
    expect(await h.sql`select is_modified, is_active from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.invoice.issued'`).toEqual([{ is_modified: false, is_active: true }]);
    await h.run({ ...h.admin, origin: "event" }, "accounting.posting_rule.sync", {});
    expect(await h.sql`select 1 from accounting.posting_rules where company_id = ${h.companyId} and event = 'invoicing.invoice.issued'`).toHaveLength(1);
  });
});
