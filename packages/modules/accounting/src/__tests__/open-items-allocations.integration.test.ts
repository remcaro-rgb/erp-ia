import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, enqueueEvent, runReport } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
// The payments harness (core, accounting on the demo chart, invoicing and payments, plan 2B Task 21): accounting cannot list payments or
// invoicing as dependencies (they depend on it), so the test reads the harness from the payments package's own tests.
import { paymentsHarness, registry, type Harness } from "../../../payments/src/__tests__/helpers";
// The demo ledger of Café del Norte (scripts/demo/accounting.ts, what `pnpm db:seed` posts): its invoices, receipts, notes and voids.
import { CREDIT_NOTES, INVOICES, OPENING_LINES } from "../../../../../scripts/demo/ledger-data";

// Open items from allocations (plan 2B Task 22; accounting design §4.12, §5.11): for a company with the payments module, the receivable
// open items follow what each recibo de caja applied to each invoice (payments' published allocations) and the notes of each invoice
// (invoicing's published note → invoice link), not FIFO by due date. What no allocation explains still applies FIFO; what an invoice
// receives beyond its documents, or the unaimed applications leave beyond every document, is a credit item; an unallocated advance
// (customer_advances) is an advance item; withholdings suffered are not customer items. A company without payments keeps the FIFO
// computation unchanged (views.integration.test.ts, reports-controls.integration.test.ts). Every test builds its own customer and data.

let h: Harness;

const state = { filters: [], sort: [], page: 1, pageSize: 500 };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Out = { rows: Row[]; total: number; aggregates: Record<string, any> };
const report = (id: string, params: Record<string, unknown>) => runReport({ sql: h.sql, registry }, h.admin, id, params, state) as Promise<Out>;
const aging = (asOf: string, kind: "receivable" | "payable" = "receivable") => report("accounting.aging", { kind, asOf });

type Item = { entry_id: string | null; account: string; original: number; open: number; kind: string; due_date: string | null };
const asItems = (rows: { entry_id: string | null; account: string; original: string; open: string; kind: string; due_date: string | null }[]): Item[] =>
  rows.map((r) => ({ ...r, original: Number(r.original), open: Number(r.open) }));
/** accounting.open_items as the admin (the caller's claims, like the report). */
const openItems = async (partyId: string, asOf = h.today): Promise<Item[]> =>
  asItems(await withClaims(h.sql, h.admin.claims, (tx) => tx<{ entry_id: string | null; account: string; original: string; open: string; kind: string; due_date: string | null }[]>`
    select o.entry_id, a.code as account, o.original::text, o.open::text, o.kind, o.due_date::text
    from accounting.open_items(${h.companyId}, ${asOf}::date) o join accounting.accounts a on a.id = o.account_id
    where o.party_id = ${partyId} order by o.kind, o.due_date nulls last, o.date, o.entry_id`));
const openOf = (items: Item[], entryId: string) => items.find((i) => i.kind === "document" && i.entry_id === entryId)?.open;
/** The receivable entry of an invoice or a note (its «Emitir» posts it inline). */
const entryOf = async (sourceId: string) => (await h.entriesOfSource(sourceId))[0]!.id;
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dueOf = async (invoiceId: string) => (await h.sql<{ d: string }[]>`select due_date::text as d from invoicing.invoices where id = ${invoiceId}`)[0]!.d;
const setPayments = (enabled: boolean) => h.sql`
  insert into kernel.company_modules (company_id, module_id, enabled, enabled_at) values (${h.companyId}, 'payments', ${enabled}, now())
  on conflict (company_id, module_id) do update set enabled = ${enabled}`;
/** What the documents say is open of an invoice: its receivable (invoicing) less what the posted receipts applied (payments). */
const documentOpen = async (invoiceId: string) => {
  const [inv] = await h.sql<{ receivable: string }[]>`select receivable::text from invoicing.v_receivable_invoices where id = ${invoiceId}`;
  return Number(inv!.receivable) - (await h.paidOf(invoiceId));
};
/** The party's balance of one account at today, from the ledger. */
const balanceOf = async (partyId: string, code: string) => Number((await h.sql<{ net: string | null }[]>`
  select sum(l.debit - l.credit)::text as net from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
  where l.company_id = ${h.companyId} and a.code = ${code} and l.party_id = ${partyId} and e.status = 'posted' and e.date <= ${h.today}::date`)[0]!.net ?? 0);
let customers = 0;
const newCustomer = (name: string) => h.newCustomer(`9012300${String(++customers).padStart(2, "0")}`, name);
const lineOf = async (invoiceId: string) => (await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`)[0]!.id;
const creditNote = async (invoiceId: string, qty: number) => {
  const note = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId, kind: "credit", concept: "1", reason: "Devolución parcial", lines: [{ invoiceLineId: await lineOf(invoiceId), qty }] });
  await h.run(h.admin, "invoicing.note.issue", { id: note.id });
  return note.id;
};
const debitNote = async (invoiceId: string, unitPrice: number) => {
  const note = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId, kind: "debit", concept: "1", reason: "Intereses de mora", lines: [{ invoiceLineId: await lineOf(invoiceId), qty: 1, unitPrice }] });
  await h.run(h.admin, "invoicing.note.issue", { id: note.id });
  return note.id;
};
const retefuente = (base: number) => [{ kind: "income" as const, code: "RTEFTE_SERVICIOS_2_5", rate: 2.5, base, amount: Math.round(base * 0.025) }];

beforeAll(async () => {
  h = await paymentsHarness();
  // The notes' numbering (credit notes, an Anular's annulment note, debit notes): plain sequence rows.
  await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, 'credit_note', 'NC', 1), (${h.companyId}, 'debit_note', 'ND', 1)`;
}, 300_000);

afterAll(async () => {
  await h?.cleanup();
});

describe("a company with payments: open items follow the allocations", () => {
  it("partial payments by two receipts with withholdings, an advance, a voided receipt, a credit note and an annulled invoice; the aging report", async () => {
    const party = await newCustomer("Cliente Asignaciones S.A.S.");
    const inv: Record<string, { id: string; total: number; entry: string }> = {};
    for (const [key, qty] of [["a", 1], ["b", 2], ["c", 3], ["d", 1]] as const) {
      const issued = await h.issuedInvoice(qty, { partyId: party });
      inv[key] = { id: issued.id, total: issued.total, entry: await entryOf(issued.id) };
    }
    expect([inv.a!.total, inv.b!.total, inv.c!.total, inv.d!.total]).toEqual([119000, 238000, 357000, 119000]);

    // B (the newer invoice) is paid in part by two receipts, the first with a retefuente: FIFO would have settled A first.
    await h.receive({ partyId: party, amount: 97500, allocations: [{ invoiceId: inv.b!.id, amount: 100000, withholdings: retefuente(100000) }] });
    await h.receive({ partyId: party, amount: 50000, method: "cash", allocations: [{ invoiceId: inv.b!.id, amount: 50000 }] });
    // A receipt with no invoice is an advance (Cr 280505): it settles nothing.
    await h.receive({ partyId: party, amount: 60000 });
    // A receipt of A, voided: A is open again.
    const voided = await h.receive({ partyId: party, amount: 119000, allocations: [{ invoiceId: inv.a!.id, amount: 119000 }] });
    await h.runStepUp("payments.payment.void", { id: voided.id, reason: "Consignación devuelta" });
    // C: paid 100.000 and credited one unit (119.000).
    await h.receive({ partyId: party, amount: 100000, allocations: [{ invoiceId: inv.c!.id, amount: 100000 }] });
    await creditNote(inv.c!.id, 1);
    // D: annulled (Anular issues the annulment credit note for the whole invoice).
    await h.runStepUp("invoicing.invoice.void", { id: inv.d!.id, reason: "Precio equivocado" });

    const items = await openItems(party);
    expect([openOf(items, inv.a!.entry), openOf(items, inv.b!.entry), openOf(items, inv.c!.entry), openOf(items, inv.d!.entry)]).toEqual([119000, 88000, 138000, 0]);
    // Every document's open amount is what the documents say: receivable less the posted allocations.
    for (const key of ["a", "b", "c", "d"]) expect(openOf(items, inv[key]!.entry)).toBe(await documentOpen(inv[key]!.id));
    // Nothing is left unexplained; the advance is its own item (280505, a credit); the retefuente (135515, a withholding suffered) is no
    // customer item (owner ruling 2026-11-05).
    expect(items.filter((i) => i.kind === "credit")).toEqual([]);
    expect(items.filter((i) => i.kind === "advance").map((i) => [i.account, i.open])).toEqual([["280505", -60000]]);
    expect(items.filter((i) => i.kind === "document").every((i) => i.account === "130505")).toBe(true);
    // The documents add up to the receivable balance of the party.
    const documents = items.filter((i) => i.kind === "document").reduce((sum, i) => sum + i.open, 0);
    expect(documents).toBe(345000);
    expect(await balanceOf(party, "130505")).toBe(345000);

    // The aging report: every open document is not due today; the advance in «Anticipos y saldos a favor»; the total net of it.
    const due = await dueOf(inv.a!.id);
    expect(await dueOf(inv.b!.id)).toBe(due);
    expect((await aging(h.today)).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 345000, b1: 0, b2: 0, b3: 0, over: 0, credits: -60000, total: 285000 });
    // 45 days past the due date: every open document in 31–60; the advance stays in its own column.
    expect((await aging(addDays(due, 45))).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 0, b1: 0, b2: 345000, b3: 0, over: 0, credits: -60000, total: 285000 });
    // The day before everything: nothing.
    expect((await aging(addDays(h.today, -1))).rows.find((r) => r.party_id === party)).toBeUndefined();
  });

  it("a debit note is a document of its invoice: a receipt of the invoice and its note settles both, and the older invoice stays open", async () => {
    const party = await newCustomer("Cliente Nota Débito S.A.S.");
    const older = await h.issuedInvoice(1, { partyId: party });
    const newer = await h.issuedInvoice(1, { partyId: party });
    const note = await debitNote(newer.id, 10000); // 10.000 + IVA 19 %
    const [noteRow] = await h.sql<{ total: string }[]>`select total::text from invoicing.notes where id = ${note}`;
    expect(Number(noteRow!.total)).toBe(11900);
    await h.receive({ partyId: party, amount: 130900, allocations: [{ invoiceId: newer.id, amount: 130900 }] });
    const items = await openItems(party);
    expect(openOf(items, await entryOf(older.id))).toBe(119000);
    expect(openOf(items, await entryOf(newer.id))).toBe(0);
    expect(openOf(items, await entryOf(note))).toBe(0);
    expect(items.filter((i) => i.kind !== "document")).toEqual([]);
  });

  it("a credit note beyond what is open of a paid invoice (a refund) is a credit item, not a payment of another invoice", async () => {
    const party = await newCustomer("Cliente Reembolso S.A.S.");
    const older = await h.issuedInvoice(1, { partyId: party });
    const paid = await h.issuedInvoice(1, { partyId: party });
    await h.receive({ partyId: party, amount: 100000, allocations: [{ invoiceId: paid.id, amount: 100000 }] });
    await creditNote(paid.id, 1); // 119.000 credited, 19.000 were open: 100.000 is the customer's
    const items = await openItems(party);
    expect(openOf(items, await entryOf(older.id))).toBe(119000);
    expect(openOf(items, await entryOf(paid.id))).toBe(0);
    expect(items.filter((i) => i.kind === "credit").map((i) => [i.account, i.open])).toEqual([["130505", -100000]]);
    expect(items.reduce((sum, i) => sum + i.open, 0)).toBe(await balanceOf(party, "130505"));
    expect((await aging(h.today)).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 119000, credits: -100000, total: 19000 });
  });

  it("one receipt over several invoices with withholdings, then voided: every invoice is open again, nothing else is left", async () => {
    const party = await newCustomer("Cliente Varias Facturas S.A.S.");
    const a = await h.issuedInvoice(1, { partyId: party });
    const b = await h.issuedInvoice(2, { partyId: party });
    const c = await h.issuedInvoice(1, { partyId: party });
    // Three allocations whose shares of the line are exact cents (largest remainder over the receipt's whole credit).
    const receipt = await h.receive({
      partyId: party, amount: 119000 + 238000 + 50000 - 2500 - 5000,
      allocations: [
        { invoiceId: a.id, amount: 119000, withholdings: retefuente(100000) },
        { invoiceId: b.id, amount: 238000, withholdings: retefuente(200000) },
        { invoiceId: c.id, amount: 50000 },
      ],
    });
    const paidItems = await openItems(party);
    expect([openOf(paidItems, await entryOf(a.id)), openOf(paidItems, await entryOf(b.id)), openOf(paidItems, await entryOf(c.id))]).toEqual([0, 0, 69000]);
    await h.runStepUp("payments.payment.void", { id: receipt.id, reason: "Cheque devuelto" });
    const items = await openItems(party);
    expect([openOf(items, await entryOf(a.id)), openOf(items, await entryOf(b.id)), openOf(items, await entryOf(c.id))]).toEqual([119000, 238000, 119000]);
    expect(items.filter((i) => i.kind !== "document" || i.account !== "130505")).toEqual([]);
    expect(items.filter((i) => i.kind === "document").length).toBe(3);
  });

  it("an advance application is aimed at its invoices like a receipt (0138): the newer invoice is settled, not the older one, the advance falls by the same amount, and an undo restores both", async () => {
    const party = await newCustomer("Cliente Aplicacion Anticipo S.A.S.");
    const older = await h.issuedInvoice(1, { partyId: party });
    const newer = await h.issuedInvoice(2, { partyId: party });
    const advance = await h.advanceReceipt(300000, { partyId: party });
    const [entryOlder, entryNewer] = [await entryOf(older.id), await entryOf(newer.id)];
    // One application over both invoices, the whole credit on the receivable one line: split over the invoices it names, not FIFO.
    const application = await h.apply([{ receiptId: advance.id, invoiceId: newer.id, amount: 200000 }, { receiptId: advance.id, invoiceId: older.id, amount: 19000 }], { partyId: party });
    let items = await openItems(party);
    expect([openOf(items, entryOlder), openOf(items, entryNewer)]).toEqual([100000, 38000]);
    expect(items.filter((i) => i.kind === "credit")).toEqual([]);
    // The advance fell by what the application drew; the party's total is unchanged by an application.
    expect(items.filter((i) => i.kind === "advance").map((i) => [i.account, i.open])).toEqual([["280505", -81000]]);
    expect(items.filter((i) => i.kind === "document").reduce((sum, i) => sum + i.open, 0)).toBe(138000);
    expect(await balanceOf(party, "130505")).toBe(357000 - 219000);
    expect(await balanceOf(party, "280505")).toBe(-81000);
    // The aging report sees it.
    expect((await aging(h.today)).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 138000, credits: -81000, total: 57000 });

    await h.runStepUp("payments.advance.undo", { id: application.id, reason: "Se aplicó a facturas equivocadas" });
    items = await openItems(party);
    expect([openOf(items, entryOlder), openOf(items, entryNewer)]).toEqual([119000, 238000]);
    expect(items.filter((i) => i.kind === "advance").map((i) => [i.account, i.open])).toEqual([["280505", -300000]]);
    expect(items.filter((i) => i.kind === "credit")).toEqual([]);
  });

  it("an invoice with a partial credit note cannot be annulled (invoicing refuses it); its open amount is what the note left", async () => {
    const party = await newCustomer("Cliente Anulación S.A.S.");
    const invoice = await h.issuedInvoice(3, { partyId: party });
    await creditNote(invoice.id, 1);
    expect(openOf(await openItems(party), await entryOf(invoice.id))).toBe(238000);
    const refused = await h.refusal(h.runStepUp("invoicing.invoice.void", { id: invoice.id, reason: "Cliente equivocado" }));
    expect(refused?.message).toMatch(/^invoice_has_note/);
    const items = await openItems(party);
    expect(openOf(items, await entryOf(invoice.id))).toBe(238000);
    expect(items.filter((i) => i.kind !== "document")).toEqual([]);
    expect((await aging(h.today)).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 238000, total: 238000 });
  });

  it("a receivable credit no allocation explains (a manual entry) still applies FIFO; what is left beyond the documents is a credit item; the control reconciliation ties", async () => {
    const party = await newCustomer("Cliente Manual S.A.S.");
    const e = await h.issuedInvoice(1, { partyId: party });
    const f = await h.issuedInvoice(2, { partyId: party });
    await h.receive({ partyId: party, amount: 238000, allocations: [{ invoiceId: f.id, amount: 238000 }] });
    const manual = await h.run<{ id: string }>(h.admin, "accounting.entry.create", {
      date: h.today, description: "Abono sin recibo",
      lines: [{ accountCode: "111005", debit: 150000, credit: 0 }, { accountCode: "130505", debit: 0, credit: 150000, partyId: party }],
    });
    await h.run(h.admin, "accounting.entry.save", { id: manual.id });
    const items = await openItems(party);
    expect([openOf(items, await entryOf(e.id)), openOf(items, await entryOf(f.id))]).toEqual([0, 0]);
    expect(items.filter((i) => i.kind === "credit").map((i) => [i.account, i.open])).toEqual([["130505", -31000]]);
    const control = await report("accounting.control_reconciliation", { asOf: h.today });
    expect(control.rows.find((r) => r.control === "receivable" && r.subject === "Cliente Manual S.A.S.")).toMatchObject({ ledger: -31000, subledger: -31000, difference: 0 });
  });
});

describe("with or without payments", () => {
  it("a receipt allocated oldest first gives FIFO's documents; one allocated to the newer invoice does not; switching payments off goes back to FIFO", async () => {
    const party = await newCustomer("Cliente FIFO S.A.S.");
    const e = await h.issuedInvoice(1, { partyId: party });
    const f = await h.issuedInvoice(2, { partyId: party });
    await h.receive({ partyId: party, amount: 219000, allocations: [{ invoiceId: e.id, amount: 119000 }, { invoiceId: f.id, amount: 100000 }] });
    const other = await newCustomer("Cliente No FIFO S.A.S.");
    const g = await h.issuedInvoice(1, { partyId: other });
    const k = await h.issuedInvoice(1, { partyId: other });
    await h.receive({ partyId: other, amount: 119000, allocations: [{ invoiceId: k.id, amount: 119000 }] });
    const documents = (items: Item[]) => items.filter((i) => i.kind === "document").map((i) => [i.entry_id, i.original, i.open]);

    const withPayments = await openItems(party);
    expect(documents(withPayments)).toEqual([[await entryOf(e.id), 119000, 0], [await entryOf(f.id), 238000, 138000]]);
    const otherWithPayments = await openItems(other);
    expect([openOf(otherWithPayments, await entryOf(g.id)), openOf(otherWithPayments, await entryOf(k.id))]).toEqual([119000, 0]);
    await setPayments(false);
    try {
      expect(documents(await openItems(party))).toEqual(documents(withPayments));
      const fifo = await openItems(other);
      expect(fifo.every((i) => i.kind === "document")).toBe(true);
      expect([openOf(fifo, await entryOf(g.id)), openOf(fifo, await entryOf(k.id))]).toEqual([0, 119000]);
    } finally {
      await setPayments(true);
    }
  });

  it("both agree on the demo ledger: its invoices, receipts (no allocations), credit notes and voids give FIFO's documents for every customer", async () => {
    // The demo's receivable history (scripts/demo/accounting.ts) delivered to the accounting consumer, as `pnpm db:seed` does for Café del
    // Norte: synthetic events (no payments allocation, no invoicing note row behind them), so nothing is aimed but the invoice void.
    const parties = new Map<string, string>();
    const partyOf = async (document: string) => {
      if (!parties.has(document)) parties.set(document, await h.newCustomer(`7${document.slice(1)}`, `Demo ${document} S.A.S.`));
      return parties.get(document)!;
    };
    const ids = (kind: string, n: number) => `019a2c4e-0000-7000-8000-${kind}${String(n).padStart(11, "0")}`;
    const run = Math.floor(Math.random() * 1e6);
    const send = async (event: string, payload: Record<string, unknown>) => {
      const chainId = crypto.randomUUID();
      const outboxId = await h.sql.begin((tx) => enqueueEvent(tx, { companyId: h.companyId, event, payload, chainId }));
      const [row] = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date }[]>`select id, event, payload, created_at from kernel.outbox where id = ${outboxId}`;
      const ctx = buildConsumerContext(h.sql, { id: row!.id, event: row!.event, createdAt: row!.created_at, companyId: h.companyId, chainId }, registry);
      for (const consumer of consumers.for(event).filter((c) => c.moduleId === "accounting")) await consumer.fn(ctx, row!.payload);
      const failures = await h.sql`select error_code, error_detail from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${outboxId} and status = 'pending'`;
      expect(failures, `${event} ${String(payload.number)}`).toEqual([]);
    };
    const customer = async (document: string) => ({ partyId: await partyOf(document), legalName: `Demo ${document} S.A.S.` });
    const money = (n: number) => Math.round(n);
    // The opening receivables.
    const opening = OPENING_LINES.filter((l) => l.accountCode === "130505");
    const entry = await h.run<{ id: string }>(h.admin, "accounting.entry.create", {
      date: `${h.year}-01-01`, description: "Saldos iniciales de cartera (demo)",
      lines: [
        ...await Promise.all(opening.map(async (l) => ({ accountCode: "130505", debit: l.debit!, credit: 0, partyId: await partyOf(l.partyDocument!), dueDate: l.dueDate }))),
        { accountCode: "310505", debit: 0, credit: opening.reduce((s, l) => s + l.debit!, 0) },
      ],
    });
    await h.run(h.admin, "accounting.entry.save", { id: entry.id });
    const totals = new Map<string, { base: number; total: number; index: number }>();
    for (const [i, spec] of INVOICES.entries()) {
      const base = spec.beverages + spec.food;
      const tax = money(base * 0.19);
      totals.set(spec.number, { base, total: base + tax, index: i + 1 });
      await send("invoicing.invoice.issued", {
        date: spec.date, number: `${spec.number}-${run}`, invoiceId: ids("a", run * 100 + i + 1), dueDate: addDays(spec.date, 30), customer: await customer(spec.customer),
        costCenterId: h.costCenterId, totals: { total: base + tax },
        lines: [{ subtotal: spec.beverages, categoryId: "bebidas" }, { subtotal: spec.food, categoryId: "comida" }],
        taxes: [{ code: "IVA19", rate: 19, amount: tax, base }],
      });
    }
    for (const [i, spec] of INVOICES.entries()) {
      if (!spec.receipt) continue;
      const { base, total } = totals.get(spec.number)!;
      const share = spec.receipt.share ?? 1;
      const applied = money(total * share);
      const paidBase = money(base * share);
      const rte = money(paidBase * 0.025);
      const ica = money(paidBase * 0.00966);
      await send("payments.received", {
        date: addDays(spec.date, spec.receipt.days), number: `RC-${run}-${i + 1}`, paymentId: ids("b", run * 100 + i + 1), method: spec.receipt.method,
        amount: applied - rte - ica, applied, advance: 0, advances: [], customer: await customer(spec.customer),
        withholdings: { income: [{ code: "RTEFTE_COMPRAS_2_5", rate: 2.5, base: paidBase, amount: rte }], vat: [], ica: [{ code: "RTEICA_BOGOTA_0_966", rate: 0.966, base: paidBase, amount: ica }] },
      });
    }
    for (const [i, note] of CREDIT_NOTES.entries()) {
      const tax = money(note.subtotal * 0.19);
      await send("invoicing.note.issued", {
        date: note.date, number: `${note.number}-${run}`, noteId: ids("e", run * 100 + i + 1), kind: "credit", annulment: false, reasonCode: "1", dueDate: note.date,
        customer: await customer(note.customer), costCenterId: h.costCenterId, totals: { total: -(note.subtotal + tax) }, lines: [{ subtotal: -note.subtotal }],
        taxes: [{ code: "IVA19", rate: 19, amount: -tax, base: -note.subtotal }],
      });
    }
    // The voids: the receipt of FE-1013 (its reversal, a debit with no allocation behind it) and the invoice FE-1015.
    const fe1013 = INVOICES.findIndex((s) => s.number === "FE-1013") + 1;
    const r1013 = INVOICES[fe1013 - 1]!;
    await send("payments.payment.voided", { date: addDays(r1013.date, r1013.receipt!.days + 3), number: `RC-${run}-${fe1013}`, paymentId: ids("b", run * 100 + fe1013) });
    const fe1015 = INVOICES.findIndex((s) => s.number === "FE-1015") + 1;
    await send("invoicing.invoice.voided", { date: INVOICES[fe1015 - 1]!.date, number: `FE-1015-${run}`, invoiceId: ids("a", run * 100 + fe1015) });

    // Each demo customer: the allocations branch's documents against FIFO's on the same lines (130505; FIFO also lists the withholdings
    // suffered, which the allocations branch leaves out by the owner's ruling). The invoice void is aimed at its invoice, FIFO applies it
    // to the oldest: that customer is compared on its total only.
    const compare = (fn: "open_items_fifo" | "open_items_allocated") => withClaims(h.sql, h.admin.claims, (tx) => tx<{ entry_id: string; party_id: string; original: string; open: string }[]>`
      select o.entry_id, o.party_id, o.original::text, o.open::text
      from ${fn === "open_items_fifo" ? tx`accounting.open_items_fifo(${h.companyId}, ${h.today}::date, false)` : tx`accounting.open_items_allocated(${h.companyId}, ${h.today}::date)`} o
      join accounting.accounts a on a.id = o.account_id
      where a.code = '130505' and o.party_id = any(${[...parties.values()]}::uuid[]) and o.entry_id is not null
      order by o.party_id, o.entry_id`);
    const fifo = await compare("open_items_fifo");
    const allocated = await compare("open_items_allocated");
    const sol = parties.get(INVOICES[fe1015 - 1]!.customer)!;
    const shape = (rows: typeof fifo, keep: (party: string) => boolean) => rows.filter((r) => keep(r.party_id)).map((r) => [r.party_id, r.entry_id, Number(r.original), Number(r.open)]);
    expect(shape(allocated, (p) => p !== sol)).toEqual(shape(fifo, (p) => p !== sol));
    expect(shape(fifo, (p) => p !== sol).length).toBeGreaterThan(15);
    const total = (rows: typeof fifo) => rows.filter((r) => r.party_id === sol).reduce((s, r) => s + Number(r.open), 0);
    expect(total(allocated)).toBe(total(fifo));
    // And neither branch has a credit item for them (the demo collects nothing beyond its invoices).
    const credits = await withClaims(h.sql, h.admin.claims, (tx) => tx`
      select 1 from accounting.open_items_allocated(${h.companyId}, ${h.today}::date) o where o.kind = 'credit' and o.party_id = any(${[...parties.values()]}::uuid[])`);
    expect(credits).toEqual([]);
  });
});

describe("access", () => {
  it("a restricted receivable account: a user without view gets none of its items, the admin all of them", async () => {
    const party = await newCustomer("Cliente Restringido S.A.S.");
    await h.issuedInvoice(1, { partyId: party });
    await h.receive({ partyId: party, amount: 50000 });
    const clerk = h.seed.claimsFor(h.seed.users.clerk!, h.companyId) as typeof h.admin.claims;
    const count = (claims: typeof h.admin.claims, code: string) => withClaims(h.sql, claims, (tx) => tx<{ n: number }[]>`
      select count(*)::int as n from accounting.open_items(${h.companyId}, ${h.today}::date) o join accounting.accounts a on a.id = o.account_id
      where o.party_id = ${party} and a.code = ${code}`).then((r) => r[0]!.n);
    expect(await count(clerk, "130505")).toBe(1);
    const [account] = await h.sql<{ id: string }[]>`select id from accounting.accounts where company_id = ${h.companyId} and code = '130505'`;
    await h.runStepUp("accounting.account_permission.update", { accountId: account!.id, access: "restricted", grants: [] });
    try {
      expect(await count(clerk, "130505")).toBe(0);
      expect(await count(clerk, "280505")).toBe(1);
      expect(await count(h.admin.claims, "130505")).toBe(1);
    } finally {
      await h.runStepUp("accounting.account_permission.update", { accountId: account!.id, access: "open", grants: [] });
    }
  });

  it("a member cannot call the published allocation and note functions directly; the aging report still answers from them", async () => {
    const party = await newCustomer("Cliente Acceso S.A.S.");
    const older = await h.issuedInvoice(1, { partyId: party });
    const newer = await h.issuedInvoice(1, { partyId: party });
    await h.receive({ partyId: party, amount: 119000, allocations: [{ invoiceId: newer.id, amount: 119000 }] });
    for (const fn of ["payments.ledger_allocations", "invoicing.ledger_note_invoices"]) {
      const refused = await withClaims(h.sql, h.admin.claims, (tx) => tx.unsafe(`select * from ${fn}('${h.companyId}')`)).then(() => null, (e: { code?: string }) => e);
      expect(refused?.code, fn).toBe("42501");
    }
    const items = await openItems(party);
    expect([openOf(items, await entryOf(older.id)), openOf(items, await entryOf(newer.id))]).toEqual([119000, 0]);
    expect((await aging(h.today)).rows.find((r) => r.party_id === party)).toMatchObject({ not_due: 119000, total: 119000 });
  });

  it("another company of the tenant sees none of these items (tenant isolation); a caller with no claims gets FIFO", async () => {
    const claims = h.seed.claimsFor(h.seed.users.both, h.otherCompanyId) as typeof h.admin.claims;
    expect((await withClaims(h.sql, claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.v_open_items`))[0]!.n).toBe(0);
    expect((await withClaims(h.sql, claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.open_items(${h.companyId}, ${h.today}::date)`))[0]!.n).toBe(0);
    expect((await withClaims(h.sql, claims, (tx) => tx<{ n: number }[]>`select count(*)::int as n from accounting.open_items_allocated(${h.companyId}, ${h.today}::date)`))[0]!.n).toBe(0);
    const [mode] = await h.sql<{ allocated: boolean }[]>`select accounting.open_items_follow_allocations(${h.companyId}) as allocated`;
    expect(mode!.allocated).toBe(false);
  });
});
