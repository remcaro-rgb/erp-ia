import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withClaims } from "@erp/kernel/testing";
import { paymentsHarness, type ApplicationOut, type Harness } from "./helpers";

// «Aplicar anticipo a factura» through the real posting engine on the demo chart (plan 2B.2 Task 36; accounting design 2026-10-28, posting
// engine, advances and receivables; main design §8.1 step 7, §22.27 links): payments.advance.apply writes an application (AP-n, lines
// advance receipt → invoice → amount), numbers it and posts it INLINE and STRICT in one transaction: Dr customer_advances (280505) / Cr
// receivable (130505), the customer as party, the application as source. The advance's open balance and the invoices' open balance count it
// (payments.advance_applied_amounts, payments.allocated_amounts, the open items), invoicing recomputes the paid stage through its consumer of
// payments.advance.applied, and payments.advance.undo (step-up) voids it and reverses the entry. Every test builds its own customer.

let h: Harness;
let customers = 0;
const newCustomer = (name: string) => h.newCustomer(`9101100${String(++customers).padStart(2, "0")}`, name);
const num = (s: string) => Number(s);

const linesOfSource = async (sourceId: string, index = 0) => {
  const entries = await h.entriesOfSource(sourceId);
  expect(entries[index]).toBeDefined();
  return (await h.linesOf(entries[index]!.id)).map((l) => [l.code, num(l.debit), num(l.credit), l.party_id]);
};
const remainingOf = async (partyId: string, receiptId: string) => (await h.openAdvances(partyId)).find((a) => a.receiptId === receiptId)?.remaining ?? 0;
const periodOfToday = async () => (await h.sql<{ id: string }[]>`select id from accounting.periods where company_id = ${h.companyId} and ${h.today}::date between starts_on and ends_on`)[0]!.id;
/** A customer with an issued invoice of `qty` units (qty × 119.000) and a posted advance receipt of `advance`. */
const scenario = async (name: string, qty: number, advance: number) => {
  const partyId = await newCustomer(name);
  const invoice = await h.issuedInvoice(qty, { partyId });
  const receipt = await h.advanceReceipt(advance, { partyId });
  return { partyId, invoice, receipt };
};
const openItems = (partyId: string) =>
  withClaims(h.sql, h.admin.claims, (tx) => tx<{ entry_id: string | null; account: string; original: string; open: string; kind: string }[]>`
    select o.entry_id, a.code as account, o.original::text, o.open::text, o.kind
    from accounting.open_items(${h.companyId}, ${h.today}::date) o join accounting.accounts a on a.id = o.account_id
    where o.party_id = ${partyId} order by o.kind, o.date, o.entry_id`);

beforeAll(async () => {
  h = await paymentsHarness();
  await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, 'credit_note', 'NC', 1)`;
}, 300_000);

afterAll(async () => {
  await h?.cleanup();
});

describe("(a) a full application", () => {
  it("settles the invoice with the advance: AP-n, Dr 280505 / Cr 130505 for the customer, the invoice paid after its consumer ran, the advance spent", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Anticipo Total S.A.S.", 4, 476000);
    expect(invoice.total).toBe(476000);
    expect(await remainingOf(partyId, receipt.id)).toBe(476000);

    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 476000 }], { partyId });
    expect(application).toMatchObject({ status: "posted", date: h.today, partyId, total: 476000 });
    expect(application.number).toMatch(/^AP-\d+$/);
    expect(application.lines).toEqual([{ receiptId: receipt.id, receiptNumber: receipt.number, invoiceId: invoice.id, invoiceNumber: invoice.number, amount: 476000 }]);

    const [entry] = await h.entriesOfSource(application.id);
    expect(entry).toMatchObject({ status: "posted", source_entity: "payments.advance_application", journal: "RC", date: h.today, total_debit: "476000.0000" });
    expect(await linesOfSource(application.id)).toEqual([["280505", 476000, 0, partyId], ["130505", 0, 476000, partyId]]);
    const [event] = await h.eventsOf("payments.advance.applied", application.id);
    expect(event!.payload).toMatchObject({
      date: h.today, number: application.number, applicationId: application.id, paymentId: application.id, total: 476000, currency: "COP",
      customer: { partyId, legalName: "Cliente Anticipo Total S.A.S." },
      allocations: [{ invoiceId: invoice.id, invoiceNumber: invoice.number, amount: 476000 }],
      advances: [{ receiptId: receipt.id, receiptNumber: receipt.number, amount: 476000 }],
    });
    expect(entry!.chain_id).toBe(event!.chain_id);

    // The balance is derived: both sides see it at once; invoicing's stage follows when its consumer runs (eventually consistent, as for receipts).
    expect(await remainingOf(partyId, receipt.id)).toBe(0);
    expect(await h.paidOf(invoice.id)).toBe(0);
    expect(await h.drain()).toEqual([]);
    expect(await h.stageOf(invoice.id)).toEqual({ stage: "paid", paid_amount: "476000.0000" });
    const list = (await h.run<{ invoices: { id: string }[] }>(h.admin, "payments.payment.open_invoices", { partyId })).invoices;
    expect(list.find((i) => i.id === invoice.id)).toBeUndefined();
  });
});

describe("(b) a partial application", () => {
  it("reduces the advance's remaining and the invoice's open; the invoice stays issued", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Anticipo Parcial S.A.S.", 2, 500000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 100000 }], { partyId });
    expect(application.total).toBe(100000);
    expect(await remainingOf(partyId, receipt.id)).toBe(400000);
    expect((await h.openAdvances(partyId))[0]).toMatchObject({ receiptId: receipt.id, advance: 500000, applied: 100000, remaining: 400000 });
    const list = (await h.run<{ invoices: { id: string; open: number }[] }>(h.admin, "payments.payment.open_invoices", { partyId })).invoices;
    expect(list.find((i) => i.id === invoice.id)?.open).toBe(138000);
    expect(await h.drain()).toEqual([]);
    expect(await h.stageOf(invoice.id)).toEqual({ stage: "issued", paid_amount: "100000.0000" });
    // The rest is applied later, in a second application over the same pair (one pair per application, many applications).
    const second = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 138000 }], { partyId });
    expect(second.number).not.toBe(application.number);
    expect(await h.drain()).toEqual([]);
    expect((await h.stageOf(invoice.id)).stage).toBe("paid");
    expect(await remainingOf(partyId, receipt.id)).toBe(262000);
  });
});

describe("(c, d) many to many: the receivable credit is one line of the whole total", () => {
  it("one advance over two invoices", async () => {
    const partyId = await newCustomer("Cliente Un Anticipo Dos Facturas S.A.S.");
    const a = await h.issuedInvoice(1, { partyId });
    const b = await h.issuedInvoice(2, { partyId });
    const receipt = await h.advanceReceipt(357000, { partyId });
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: a.id, amount: 119000 }, { receiptId: receipt.id, invoiceId: b.id, amount: 200000 }], { partyId });
    expect(application.total).toBe(319000);
    expect(application.lines.map((l) => [l.invoiceId, l.amount])).toEqual([[a.id, 119000], [b.id, 200000]]);
    expect(await linesOfSource(application.id)).toEqual([["280505", 319000, 0, partyId], ["130505", 0, 319000, partyId]]);
    expect(await remainingOf(partyId, receipt.id)).toBe(38000);
    // Open items by invoice, exact to the cent: the application's one credit is split over the two invoices.
    const items = await openItems(partyId);
    const documents = items.filter((i) => i.kind === "document");
    expect(documents.map((i) => num(i.open)).sort((x, y) => x - y)).toEqual([0, 38000]);
    expect(items.filter((i) => i.kind === "advance").map((i) => [i.account, num(i.open)])).toEqual([["280505", -38000]]);
  });

  it("two advances over one invoice", async () => {
    const partyId = await newCustomer("Cliente Dos Anticipos Una Factura S.A.S.");
    const invoice = await h.issuedInvoice(1, { partyId });
    const r1 = await h.advanceReceipt(70000, { partyId });
    const r2 = await h.advanceReceipt(80000, { partyId });
    const application = await h.apply([{ receiptId: r1.id, invoiceId: invoice.id, amount: 70000 }, { receiptId: r2.id, invoiceId: invoice.id, amount: 49000 }], { partyId });
    expect(application.total).toBe(119000);
    expect(await linesOfSource(application.id)).toEqual([["280505", 119000, 0, partyId], ["130505", 0, 119000, partyId]]);
    expect(await remainingOf(partyId, r1.id)).toBe(0);
    expect(await remainingOf(partyId, r2.id)).toBe(31000);
    const items = await openItems(partyId);
    expect(items.filter((i) => i.kind === "document").map((i) => num(i.open))).toEqual([0]);
    expect(await h.drain()).toEqual([]);
    expect((await h.stageOf(invoice.id)).stage).toBe("paid");
  });
});

describe("refusals write nothing: no row, no entry, no number", () => {
  const refuses = async (code: RegExp, run: () => Promise<unknown>) => {
    const before = await h.applicationFootprint();
    const refused = await h.refusal(run());
    expect(refused?.message).toMatch(code);
    expect(await h.applicationFootprint()).toEqual(before);
    return refused;
  };

  it("over the advance's remaining, over the invoice's open (also when a receipt paid part of it)", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Excesos S.A.S.", 1, 50000);
    await refuses(/advance_exceeds_open/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 50000.01 }], { partyId }));
    await h.receive({ partyId, amount: 100000, allocations: [{ invoiceId: invoice.id, amount: 100000 }] });
    const refused = await refuses(/allocation_exceeds_open/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 30000 }], { partyId }));
    expect(JSON.stringify(refused?.details)).toContain("19.000,00");
    expect((await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 19000 }], { partyId })).status).toBe("posted");
  });

  it("an invoice the DIAN has not accepted, one with an annulment in progress, a draft, and another customer's invoice or advance", async () => {
    const partyId = await newCustomer("Cliente Facturas Bloqueadas S.A.S.");
    const receipt = await h.advanceReceipt(500000, { partyId });
    const pending = await h.issuedInvoice(1, { partyId, accepted: false });
    await refuses(/invoice_not_accepted/, () => h.apply([{ receiptId: receipt.id, invoiceId: pending.id, amount: 1000 }], { partyId }));
    const voiding = await h.issuedInvoice(1, { partyId });
    await h.runStepUp("invoicing.invoice.void", { id: voiding.id, reason: "Precio equivocado" });
    await refuses(/invoice_annulment_pending/, () => h.apply([{ receiptId: receipt.id, invoiceId: voiding.id, amount: 1000 }], { partyId }));
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId, paymentForm: "2", lines: [{ productId: h.servicio, qty: 1 }] });
    await refuses(/invoice_not_issued/, () => h.apply([{ receiptId: receipt.id, invoiceId: draft.id, amount: 1000 }], { partyId }));
    await refuses(/invoice_not_found/, () => h.apply([{ receiptId: receipt.id, invoiceId: "0192b4c0-0000-7000-8000-0000000000ff", amount: 1000 }], { partyId }));

    const other = await newCustomer("Otro Cliente Facturas S.A.S.");
    const theirs = await h.issuedInvoice(1, { partyId: other });
    await refuses(/invoice_other_customer/, () => h.apply([{ receiptId: receipt.id, invoiceId: theirs.id, amount: 1000 }], { partyId }));
    const theirAdvance = await h.advanceReceipt(40000, { partyId: other });
    const mine = await h.issuedInvoice(1, { partyId });
    await refuses(/advance_other_customer/, () => h.apply([{ receiptId: theirAdvance.id, invoiceId: mine.id, amount: 1000 }], { partyId }));
    await refuses(/advance_not_found/, () => h.apply([{ receiptId: "0192b4c0-0000-7000-8000-0000000000fe", invoiceId: mine.id, amount: 1000 }], { partyId }));
  });

  it("a voided receipt as the advance, a duplicate pair, an invoice in another currency, a date before the receipt or after today, a customer not invoice_ready", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Fechas y Monedas S.A.S.", 1, 119000);
    const gone = await h.advanceReceipt(10000, { partyId });
    await h.runStepUp("payments.payment.void", { id: gone.id, reason: "Consignación devuelta" });
    await refuses(/advance_not_posted/, () => h.apply([{ receiptId: gone.id, invoiceId: invoice.id, amount: 1000 }], { partyId }));
    // A Borrador receipt (written straight, as no process leaves one) is no advance either.
    const [draft] = await h.sql<{ id: string }[]>`
      insert into payments.receipts (company_id, date, party_id, method_id, method_code, currency, exchange_rate, amount, advance)
      values (${h.companyId}, ${h.today}, ${partyId}, ${h.methods.transfer}, 'transfer', 'COP', 1, 5000, 5000) returning id`;
    await refuses(/advance_not_posted/, () => h.apply([{ receiptId: draft!.id, invoiceId: invoice.id, amount: 1000 }], { partyId }));
    await refuses(/duplicate_pair/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }, { receiptId: receipt.id, invoiceId: invoice.id, amount: 2000 }], { partyId }));
    const usd = await h.issuedInvoice(1, { partyId, currency: "USD", exchangeRate: 4000 });
    await refuses(/currency_not_supported/, () => h.apply([{ receiptId: receipt.id, invoiceId: usd.id, amount: 1 }], { partyId }));
    const [dates] = await h.sql<{ before: string; after: string }[]>`select (${h.today}::date - 1)::text as before, (${h.today}::date + 1)::text as after`;
    await refuses(/application_before_receipt/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId, date: dates!.before }));
    await refuses(/application_in_future/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId, date: dates!.after }));
    const unready = await h.newCustomer(`9101199${String(++customers).padStart(2, "0")}`, "Cliente sin RUT S.A.S.", false);
    const refused = await refuses(/not_invoice_ready/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId: unready }));
    expect(JSON.stringify(refused?.details)).toMatch(/faltan archivos/);
  });

  it("a period closed on the date refuses the whole application (inline strict)", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Periodo Cerrado S.A.S.", 1, 119000);
    const period = await periodOfToday();
    await h.sql`update accounting.periods set status = 'closed' where id = ${period}`;
    try {
      await refuses(/closed_period/, () => h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId }));
    } finally {
      await h.sql`update accounting.periods set status = 'open' where id = ${period}`;
    }
    expect((await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId })).status).toBe("posted");
  });

  it("the header's total is the sum of its lines; a replay with the same idempotency key answers the first result", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Idempotente S.A.S.", 1, 119000);
    const first = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 50000 }], { partyId, idempotencyKey: "apply-1" });
    const replay = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 50000 }], { partyId, idempotencyKey: "apply-1" });
    expect(replay.id).toBe(first.id);
    const [row] = await h.sql<{ total: string; lines: string }[]>`
      select a.total::text, (select sum(l.amount) from payments.advance_application_lines l where l.application_id = a.id)::text as lines from payments.advance_applications a where a.id = ${first.id}`;
    expect(row).toEqual({ total: "50000.0000", lines: "50000.0000" });
    expect(await remainingOf(partyId, receipt.id)).toBe(69000);
  });
});

describe("(e) undo", () => {
  it("is step-up; it voids the application, reverses the entry, restores both balances and marks the links voided", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Deshacer S.A.S.", 1, 119000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    expect(await h.drain()).toEqual([]);
    expect((await h.stageOf(invoice.id)).stage).toBe("paid");

    expect((await h.refusal(h.run(h.admin, "payments.advance.undo", { id: application.id, reason: "Se aplicó a la factura equivocada" })))?.code).toBe("step_up_required");
    const undone = await h.runStepUp<{ id: string; status: string; number: string }>("payments.advance.undo", { id: application.id, reason: "Se aplicó a la factura equivocada" });
    expect(undone).toEqual({ id: application.id, status: "voided", number: application.number });
    expect((await h.sql`select status, void_reason from payments.advance_applications where id = ${application.id}`)[0]).toEqual({ status: "voided", void_reason: "Se aplicó a la factura equivocada" });

    const entries = await h.entriesOfSource(application.id);
    expect(entries).toHaveLength(2);
    expect(entries[1]!.reversal_of_id).toBe(entries[0]!.id);
    expect(entries[1]!.total_debit).toBe(entries[0]!.total_debit);
    const original = await linesOfSource(application.id, 0);
    expect(await linesOfSource(application.id, 1)).toEqual(original.map(([code, debit, credit, party]) => [code, credit, debit, party]));
    const [event] = await h.eventsOf("payments.advance.unapplied", application.id);
    expect(event!.payload).toMatchObject({ applicationId: application.id, paymentId: application.id, number: application.number, partyId, allocations: [{ invoiceId: invoice.id, amount: 119000 }] });

    // The balances are derived, so voiding the row restores both.
    expect(await remainingOf(partyId, receipt.id)).toBe(119000);
    expect(await h.drain()).toEqual([]);
    expect(await h.stageOf(invoice.id)).toEqual({ stage: "issued", paid_amount: "0.0000" });
    const links = await h.sql<{ kind: string; voided: boolean }[]>`
      select kind, voided_at is not null as voided from kernel.document_links where company_id = ${h.companyId} and (to_id = ${application.id} or from_id = ${application.id}) order by kind`;
    expect(links).toEqual([{ kind: "invoice_to_application", voided: true }, { kind: "receipt_to_application", voided: true }]);

    // Twice is refused; the advance can be applied again.
    expect((await h.refusal(h.runStepUp("payments.advance.undo", { id: application.id, reason: "Otra vez" })))?.code).toBe("invalid_state");
    expect((await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId })).status).toBe("posted");
  });

  it("is refused when the reversal cannot post (a closed period): the application stays", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Deshacer Cerrado S.A.S.", 1, 119000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    const period = await periodOfToday();
    await h.sql`update accounting.periods set status = 'closed' where id = ${period}`;
    try {
      expect((await h.refusal(h.runStepUp("payments.advance.undo", { id: application.id, reason: "x" })))?.message).toMatch(/closed_period/);
      expect((await h.sql`select status from payments.advance_applications where id = ${application.id}`)[0]!.status).toBe("posted");
      expect(await h.entriesOfSource(application.id)).toHaveLength(1);
    } finally {
      await h.sql`update accounting.periods set status = 'open' where id = ${period}`;
    }
  });
});

describe("(f) the receipt's Anular", () => {
  it("is refused while a live application draws on its advance, and allowed after the undo", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Anular Recibo S.A.S.", 1, 200000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    const refused = await h.refusal(h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" }));
    expect(refused?.message).toMatch(/receipt_has_applications/);
    expect((await h.sql`select status from payments.receipts where id = ${receipt.id}`)[0]!.status).toBe("posted");
    await h.runStepUp("payments.advance.undo", { id: application.id, reason: "Se aplicó mal" });
    expect(await h.runStepUp<{ status: string }>("payments.payment.void", { id: receipt.id, reason: "Consignación devuelta" })).toMatchObject({ status: "voided" });
  });
});

describe("(g) document links", () => {
  it("writes invoice_to_application and receipt_to_application, shown by the walk both ways", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Enlaces S.A.S.", 1, 119000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    const links = await h.sql<{ kind: string; from_entity: string; from_id: string; to_entity: string; to_id: string }[]>`
      select kind, from_entity, from_id, to_entity, to_id from kernel.document_links where company_id = ${h.companyId} and to_id = ${application.id} order by kind`;
    expect(links).toEqual([
      { kind: "invoice_to_application", from_entity: "invoicing.invoice", from_id: invoice.id, to_entity: "payments.advance_application", to_id: application.id },
      { kind: "receipt_to_application", from_entity: "payments.receipt", from_id: receipt.id, to_entity: "payments.advance_application", to_id: application.id },
    ]);
    type Trail = { nodes: { direction: string; kind: string | null; entity: string; id: string; voided: boolean }[]; hidden: number };
    const up = await h.run<Trail>(h.admin, "kernel.document_link.trail", { entity: "payments.advance_application", id: application.id, direction: "up" });
    expect(up.nodes.map((n) => [n.kind, n.entity, n.id]).sort()).toEqual([
      ["invoice_to_application", "invoicing.invoice", invoice.id], ["receipt_to_application", "payments.receipt", receipt.id],
    ].sort());
    const down = await h.run<Trail>(h.admin, "kernel.document_link.trail", { entity: "payments.receipt", id: receipt.id, direction: "down" });
    expect(down.nodes.map((n) => [n.kind, n.entity, n.id])).toContainEqual(["receipt_to_application", "payments.advance_application", application.id]);
    const fromInvoice = await h.run<Trail>(h.admin, "kernel.document_link.trail", { entity: "invoicing.invoice", id: invoice.id, direction: "down" });
    expect(fromInvoice.nodes.map((n) => [n.kind, n.entity, n.id])).toContainEqual(["invoice_to_application", "payments.advance_application", application.id]);
    expect(up.hidden).toBe(0);
  });
});

describe("(i) audit", () => {
  it("every run is audited with its origin, actor and chain; the rows of header and lines too; the chain reaches the event's consumers; a denied run is audited", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Auditoria S.A.S.", 1, 119000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    const rows = await h.sql<{ entity: string; action: string; origin: string; actor_user_id: string; chain_id: string; process_id: string }[]>`
      select entity, action, origin, actor_user_id, chain_id, process_id from kernel.audit_log
      where company_id = ${h.companyId} and process_id = 'payments.advance.apply' and row_id in (${application.id}, (select id from payments.advance_application_lines where application_id = ${application.id}))
      order by occurred_at, id`;
    // The rows of the header and the lines are audited under their tables, and the run itself under the process's family (entity payments.advance).
    expect(rows.map((r) => [r.entity, r.action])).toEqual(expect.arrayContaining([["payments.advance_applications", "insert"], ["payments.advance_application_lines", "insert"]]));
    expect(rows.every((r) => r.origin === "ui" && r.actor_user_id === h.admin.claims.sub)).toBe(true);
    // The run itself: exactly one row for the apply (entity payments.advance, the process's family; the audit's actions are insert / update /
    // delete / consult / denied, so a successful run is its `insert`), with origin ui, the actor and the chain of the event and the entry.
    const runRows = rows.filter((r) => r.entity === "payments.advance");
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({ action: "insert", origin: "ui", actor_user_id: h.admin.claims.sub, process_id: "payments.advance.apply" });
    const chain = rows[0]!.chain_id;
    expect(runRows[0]!.chain_id).toBe(chain);
    expect(new Set(rows.map((r) => r.chain_id)).size).toBe(1);
    const [event] = await h.eventsOf("payments.advance.applied", application.id);
    const [entry] = await h.entriesOfSource(application.id);
    expect([event!.chain_id, entry!.chain_id]).toEqual([chain, chain]);
    // The consumer of invoicing runs as an event, in the same chain.
    expect(await h.drain()).toEqual([]);
    const consumed = await h.sql<{ origin: string }[]>`select origin from kernel.audit_log where company_id = ${h.companyId} and chain_id = ${chain} and process_id = 'invoicing.invoice.record_payments'`;
    expect(consumed.length).toBeGreaterThan(0);
    expect(consumed.every((r) => r.origin === "event")).toBe(true);

    const clerk: typeof h.admin = { ...h.admin, claims: h.seed.claimsFor(h.seed.users.clerk!, h.companyId) as typeof h.admin.claims };
    const denied = await h.refusal(h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId }, clerk));
    expect(denied?.code).toBe("forbidden");
    const [audited] = await h.sql<{ n: number }[]>`select count(*)::int as n from kernel.audit_log where company_id = ${h.companyId} and process_id = 'payments.advance.apply' and action = 'denied'`;
    expect(audited!.n).toBeGreaterThan(0);
  });
});

describe("(j) tenant isolation", () => {
  it("the other company sees no application, no line and no advance through any view or function", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Aislado S.A.S.", 1, 119000);
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 50000 }], { partyId });
    const other = { ...h.admin, claims: h.seed.claimsFor(h.seed.users.both, h.otherCompanyId) as typeof h.admin.claims };
    const seen = await withClaims(h.sql, other.claims, async (tx) => ({
      applications: await tx`select id from payments.v_advance_applications where id = ${application.id}`,
      lines: await tx`select id from payments.v_advance_application_lines where application_id = ${application.id}`,
    }));
    expect(seen).toEqual({ applications: [], lines: [] });
    // The definer function answers only inside a payments process, and only for the caller's active company.
    await expect(h.sql`select * from payments.advance_applied_amounts(array[${receipt.id}]::uuid[])`).rejects.toThrow(/only inside a payments process/);
    const appliedAs = (claims: typeof h.admin.claims) => withClaims(h.sql, claims, async (tx) => {
      await tx`select set_config('erp.audit_process_id', 'payments.advance.open', true)`;
      return tx<{ receipt_id: string; applied: string }[]>`select receipt_id, applied::text from payments.advance_applied_amounts(array[${receipt.id}]::uuid[])`;
    });
    expect((await appliedAs(h.admin.claims)).map((r) => [r.receipt_id, num(r.applied)])).toEqual([[receipt.id, 50000]]);
    expect(await appliedAs(other.claims)).toEqual([]);
    expect((await h.refusal(h.run(other, "payments.advance.open", { partyId })))?.message).toMatch(/invalid_party/);
    expect((await h.refusal(h.run(other, "payments.advance_application.consult", { id: application.id })))?.code).toBe("not_found");
  });
});

describe("(k) permissions and masking (rule 14)", () => {
  it("a role without payments.advance.apply is denied; a role that cannot see the advance's number, date or amount gets forbidden from the consult", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Mascaras S.A.S.", 1, 119000);
    const clerk: typeof h.admin = { ...h.admin, claims: h.seed.claimsFor(h.seed.users.clerk!, h.companyId) as typeof h.admin.claims };
    expect((await h.refusal(h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 1000 }], { partyId }, clerk)))?.code).toBe("forbidden");
    expect((await h.openAdvances(partyId)).map((a) => a.receiptId)).toEqual([receipt.id]);
    // The company's admin role is exempt from field masks (kernel.field_visible), so the member role (the harness's clerk) is the masked caller.
    const roleId = h.seed.companies[0]!.memberRoleId;
    await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${roleId}, 'payments.advance.open') on conflict do nothing`;
    expect((await h.openAdvances(partyId, clerk)).map((a) => a.receiptId)).toEqual([receipt.id]);
    for (const field of ["advance", "number", "date"]) {
      await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${roleId}, 'payments.receipt', ${field}, 'masked')`;
      try {
        const refused = await h.refusal(h.openAdvances(partyId, clerk));
        expect(refused?.code, field).toBe("forbidden");
      } finally {
        await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${roleId} and entity = 'payments.receipt' and field = ${field}`;
      }
    }
    // The applied figure is the lines' amount: masked, the consult is forbidden too (no side channel).
    await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${roleId}, 'payments.advance_application_line', 'amount', 'masked')`;
    try {
      expect((await h.refusal(h.openAdvances(partyId, clerk)))?.code).toBe("forbidden");
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${roleId} and entity = 'payments.advance_application_line' and field = 'amount'`;
    }
    expect((await h.openAdvances(partyId, clerk)).map((a) => a.receiptId)).toEqual([receipt.id]);
  });

  // Whole-branch review F-2.4 (rule 14): payments.advance.apply runs the same field checks as the consult, so a refusal that names the
  // remaining advance («tiene un saldo de $ X») never reaches a caller who may not see it.
  it("a role holding payments.advance.apply but with the advance masked is forbidden before any refusal discloses the remaining advance", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Aplica Mascaras S.A.S.", 1, 119000);
    const clerk: typeof h.admin = { ...h.admin, claims: h.seed.claimsFor(h.seed.users.clerk!, h.companyId) as typeof h.admin.claims };
    const roleId = h.seed.companies[0]!.memberRoleId;
    await h.sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${h.companyId}, ${roleId}, 'payments.advance.apply') on conflict do nothing`;
    try {
      // Unmasked, an over-application is refused with the figure (the caller may see it).
      const plain = await h.refusal(h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 999999999 }], { partyId }, clerk));
      expect(plain?.code).toBe("invalid_input");
      expect(JSON.stringify(plain?.details ?? plain?.message)).toMatch(/advance_exceeds_open|saldo/);
      for (const [entity, field] of [["payments.receipt", "advance"], ["payments.receipt", "number"], ["payments.advance_application_line", "amount"]] as const) {
        await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${roleId}, ${entity}, ${field}, 'masked')`;
        try {
          const refused = await h.refusal(h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 999999999 }], { partyId }, clerk));
          expect(refused?.code, `${entity}.${field}`).toBe("forbidden");
          expect(JSON.stringify([refused?.message, refused?.details ?? null]), `${entity}.${field}`).not.toMatch(/saldo/);
        } finally {
          await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${roleId} and entity = ${entity} and field = ${field}`;
        }
      }
    } finally {
      await h.sql`delete from kernel.process_permissions where company_id = ${h.companyId} and role_id = ${roleId} and process_id = 'payments.advance.apply'`;
    }
  });
});

describe("(l) concurrency", () => {
  it("two applications of the same advance at once never exceed it", async () => {
    const partyId = await newCustomer("Cliente Concurrente S.A.S.");
    const a = await h.issuedInvoice(1, { partyId });
    const b = await h.issuedInvoice(1, { partyId });
    const receipt = await h.advanceReceipt(100000, { partyId });
    const results = await Promise.allSettled([
      h.apply([{ receiptId: receipt.id, invoiceId: a.id, amount: 80000 }], { partyId }),
      h.apply([{ receiptId: receipt.id, invoiceId: b.id, amount: 80000 }], { partyId }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String((rejected.reason as Error).message)).toMatch(/advance_exceeds_open/);
    expect(await remainingOf(partyId, receipt.id)).toBe(20000);
  });

  it("an application racing a receipt of the same invoice never exceeds the open: one wins, the other is refused", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Carrera S.A.S.", 1, 119000);
    const results = await Promise.allSettled([
      h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId }),
      h.receive({ partyId, amount: 119000, allocations: [{ invoiceId: invoice.id, amount: 119000 }] }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String((rejected.reason as Error).message)).toMatch(/allocation_exceeds_open/);
  });
});

describe("(m) the published balances count applications", () => {
  it("payments.allocated_amounts adds the posted applications and drops a voided one; the receipt form's open list shows the reduced open", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Saldos S.A.S.", 1, 119000);
    await h.receive({ partyId, amount: 19000, allocations: [{ invoiceId: invoice.id, amount: 19000 }] });
    const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 60000 }], { partyId });
    const open = async () => (await h.run<{ invoices: { id: string; open: number }[] }>(h.admin, "payments.payment.open_invoices", { partyId })).invoices.find((i) => i.id === invoice.id)?.open;
    expect(await open()).toBe(40000);
    await h.runStepUp("payments.advance.undo", { id: application.id, reason: "Aplicación equivocada" });
    expect(await open()).toBe(100000);
  });
});

describe("(n) open items after an application", () => {
  it("the invoice is reduced and the advance reduced by the same amount: the party's total is unchanged", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Antiguedad S.A.S.", 2, 100000);
    const before = await openItems(partyId);
    const total = (items: typeof before) => items.reduce((sum, i) => sum + num(i.open), 0);
    expect(before.filter((i) => i.kind === "document").map((i) => num(i.open))).toEqual([238000]);
    expect(before.filter((i) => i.kind === "advance").map((i) => num(i.open))).toEqual([-100000]);
    await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 60000 }], { partyId });
    const after = await openItems(partyId);
    expect(after.filter((i) => i.kind === "document").map((i) => num(i.open))).toEqual([178000]);
    expect(after.filter((i) => i.kind === "advance").map((i) => num(i.open))).toEqual([-40000]);
    expect(total(after)).toBe(total(before));
    expect(total(after)).toBe(138000);
  });
});

describe("(h) asynchronous posting mode (Task 33)", () => {
  it("the application commits with no entry, the event is queued, the consumer posts it and the invoice is paid afterwards; undoing a still-queued application leaves no entry", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Asincrono S.A.S.", 1, 238000);
    const second = await h.issuedInvoice(1, { partyId });
    await h.runStepUp("accounting.posting_mode.set", { mode: "asynchronous" });
    try {
      const application = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
      expect(application.status).toBe("posted");
      expect(await h.entriesOfSource(application.id)).toEqual([]);
      const [queued] = await h.eventsOf("payments.advance.applied", application.id);
      expect((await h.sql`select 1 from kernel.outbox_deliveries where outbox_id = ${queued!.id} and module_id = 'accounting'`).length).toBe(0);
      expect(await h.drain(["accounting"])).toEqual([]);
      const [entry] = await h.entriesOfSource(application.id);
      expect(entry).toMatchObject({ status: "posted", total_debit: "119000.0000" });
      expect(await linesOfSource(application.id)).toEqual([["280505", 119000, 0, partyId], ["130505", 0, 119000, partyId]]);
      expect(await h.drain(["invoicing"])).toEqual([]);
      expect((await h.stageOf(invoice.id)).stage).toBe("paid");

      // A still-queued application voided: its event is dismissed and no entry ever exists for it.
      const parked = await h.apply([{ receiptId: receipt.id, invoiceId: second.id, amount: 119000 }], { partyId });
      expect(await h.entriesOfSource(parked.id)).toEqual([]);
      await h.runStepUp("payments.advance.undo", { id: parked.id, reason: "Aplicación equivocada" });
      expect(await h.drain(["accounting"])).toEqual([]);
      expect(await h.entriesOfSource(parked.id)).toEqual([]);
      expect(await remainingOf(partyId, receipt.id)).toBe(119000);
    } finally {
      await h.runStepUp("accounting.posting_mode.set", { mode: "inline_strict" });
    }
  });
});

describe("the application record: Borrador delete, consult and frozen rows", () => {
  it("a posted application cannot be edited or deleted; its consult returns the header and the lines", async () => {
    const { partyId, invoice, receipt } = await scenario("Cliente Registro S.A.S.", 1, 119000);
    const application: ApplicationOut = await h.apply([{ receiptId: receipt.id, invoiceId: invoice.id, amount: 119000 }], { partyId });
    const consulted = await h.run<{ id: string; number: string; total: string | number; lines: { amount: unknown }[] }>(h.admin, "payments.advance_application.consult", { id: application.id });
    expect(consulted).toMatchObject({ id: application.id, number: application.number });
    expect(consulted.lines).toHaveLength(1);
    // The line's own consult (what the grid of lines needs, like payments.receipt_allocation.consult): the masked row of one line.
    const lineId = (consulted.lines[0] as unknown as { id: string }).id;
    expect(await h.run(h.admin, "payments.advance_application_line.consult", { id: lineId })).toMatchObject({ id: lineId, application_id: application.id, receipt_id: receipt.id, invoice_id: invoice.id });
    expect((await h.refusal(h.run(h.admin, "payments.advance_application_line.consult", { id: application.id })))?.code).toBe("not_found");
    await expect(h.sql`update payments.advance_applications set total = 1 where id = ${application.id}`).rejects.toThrow(/no cambia|registrada|frozen/i);
    await expect(h.sql`delete from payments.advance_application_lines where application_id = ${application.id}`).rejects.toThrow();
    expect((await h.refusal(h.run(h.admin, "payments.advance_application.delete", { id: application.id })))?.code).toMatch(/invalid_(state|input)/);
  });
});
