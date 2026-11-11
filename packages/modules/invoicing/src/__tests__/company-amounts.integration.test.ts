import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import invoiceIssuedRule from "../rules/invoice-issued.json" with { type: "json" };
import noteAnnulmentRule from "../rules/note-annulment-issued.json" with { type: "json" };
import noteCreditRule from "../rules/note-credit-issued.json" with { type: "json" };
import noteDebitRule from "../rules/note-debit-issued.json" with { type: "json" };
import { defineEntity, maskedViewSql } from "@erp/kernel";
import { withClaims } from "@erp/kernel/testing";
import { INVOICING_ENTITIES } from "../index";
import { invoicingHarness, type Harness, type InvoiceOut } from "./helpers";

// Company amounts at «Emitir» and rules with both amounts (plan 2B.2 Task 34.4; FX §4, §9 notes, §11 0148, 0149; owner items 120, 123;
// rulings R34-4, R34-5, R34-8):
//   (2) migration 0148 backfills the company amount of every existing line and tax as its document amount × the rate (half-up per line):
//       a COP row equals its document amount; a USD invoice of two lines stores the pesos of each line, their sum is total_company, and its
//       entry is in USD (debit_doc in dollars, debit in the stored pesos), balanced in both;
//   (3) a company whose invoice-issued copy was edited (no currency path) posts pesos only (R34-5) and gets one recommendation; an unedited
//       copy is rewritten by 0149, which can run twice;
//   (5) a credit note of a USD invoice takes the invoice's rate: it posts at the carrying rate, never an exchange difference;
//   (9) a viewer whose role masks the document amount reads its company twin masked too (rule 14, FX §10);
//   (6) a rate more than 0,005 % off the TRM of the issue date issues with rateWarning { trm, rate } (R34-8); the TRM's own rate → null.

const TRM = 4123.45;
const migration = (name: string) => readFileSync(new URL(`../../../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const RULES = [invoiceIssuedRule, noteAnnulmentRule, noteCreditRule, noteDebitRule];

/** A rule as 2A shipped it (before Task 34.4): no currency path, every amount the company field. */
type Template = { currency?: string; exchangeRate?: string; lines: { amount: string; amountCompany?: string }[] } & Record<string, unknown>;
const legacy = (template: Template): Template => {
  const rest: Template = { ...template };
  delete rest.currency;
  delete rest.exchangeRate;
  return { ...rest, lines: template.lines.map(({ amountCompany, ...line }) => ({ ...line, amount: amountCompany ?? line.amount })) };
};

let h: Harness;
let buyer: string;
beforeAll(async () => {
  h = await invoicingHarness();
  buyer = await h.foreignBuyer("777123456", "Northwind Test Roasters LLC");
  await h.sql`insert into core.exchange_rates (company_id, currency, rate_date, rate, source) values (${h.companyId}, 'USD', ${h.today}, ${TRM}, 'trm')`;
  // The notes' numbering (a plain sequence row per kind, as note.integration.test.ts).
  for (const [type, prefix] of [["credit_note", "NC"], ["debit_note", "ND"]] as const) {
    await h.sql`insert into core.document_sequences(company_id, document_type, prefix, next_number) values (${h.companyId}, ${type}, ${prefix}, 1)`;
  }
}, 300_000);
afterAll(async () => {
  await h.sql`delete from core.exchange_rates where company_id = ${h.companyId}`;
  await h.cleanup();
});

type Issued = InvoiceOut & { rateWarning: { trm: number; rate: number } | null };
const usdInvoice = async (exchangeRate = TRM, lines = [{ productId: h.servicio, qty: 1, unitPrice: 12.37 }, { productId: h.servicio, qty: 3, unitPrice: 7.29 }]) => {
  const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: buyer, currency: "USD", exchangeRate, lines });
  return h.run<Issued>(h.admin, "invoicing.invoice.issue", { id: draft.id });
};
const lineAmounts = (invoiceId: string) => h.sql<{ base: string; subtotal_company: string }[]>`
  select base::text, subtotal_company::text from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;
const taxAmounts = (invoiceId: string) => h.sql<{ amount: string; amount_company: string }[]>`
  select amount::text, amount_company::text from invoicing.invoice_taxes where invoice_id = ${invoiceId} order by seq`;
const headerOf = async (invoiceId: string) => (await h.sql<{ total: string; total_company: string; exchange_rate: string }[]>`
  select total::text, total_company::text, exchange_rate::text from invoicing.invoices where id = ${invoiceId}`)[0]!;
/** The entry an event posted: its currency and rate, and every line's four amounts. */
const entryOf = async (sourceEventId: string) => {
  const [entry] = await h.sql<{ id: string; currency: string; exchange_rate: string }[]>`
    select id, currency, exchange_rate::text from accounting.entries where company_id = ${h.companyId} and source_event_id = ${sourceEventId}`;
  const lines = await h.sql<{ debit: string; credit: string; debit_doc: string; credit_doc: string }[]>`
    select debit::text, credit::text, debit_doc::text, credit_doc::text from accounting.entry_lines where entry_id = ${entry!.id} order by line_no`;
  const sum = (k: "debit" | "credit" | "debit_doc" | "credit_doc") => Math.round(lines.reduce((s, l) => s + Number(l[k]) * 100, 0)) / 100;
  return { entry: entry!, lines, debit: sum("debit"), credit: sum("credit"), debitDoc: sum("debit_doc"), creditDoc: sum("credit_doc") };
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const setRule = (name: string, template: unknown, modified: boolean) =>
  h.sql`update accounting.posting_rules set template = ${h.sql.json(template as never)}, is_modified = ${modified}
        where company_id = ${h.companyId} and name = ${name}`;
const ruleTemplate = async (name: string) => (await h.sql<{ template: unknown }[]>`
  select template from accounting.posting_rules where company_id = ${h.companyId} and name = ${name}`)[0]!.template;

describe("company amounts stored at «Emitir» (0148, item 120)", () => {
  it("0148's backfill makes a COP row's company amounts its document amounts, and re-running the file changes nothing", async () => {
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 3 }, { productId: h.servicio, qty: 1 }] });
    const issued = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    // A row as it stood before 0148 (the column had no value of its own): the backfill gives it back.
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoice_lines set subtotal_company = 0 where invoice_id = ${issued.id}`;
      await tx`update invoicing.invoice_taxes set amount_company = 0 where invoice_id = ${issued.id}`;
    });
    // 0148 re-creates the masked views as they stood then; a later migration (0167: v_invoice_lines.lots) appended columns. In the same
    // transaction, the views of today are put back (generated from entities.ts, as the migrations paste them), so no other test file ever
    // reads the old shape.
    const today = ["invoicing.invoice_line", "invoicing.invoice_tax", "invoicing.note_line", "invoicing.note_tax"].map((id) => maskedViewSql(defineEntity(INVOICING_ENTITIES.find((e) => e.id === id)!)));
    for (let run = 0; run < 2; run++) {
      await h.sql.begin(async (tx) => {
        await tx.unsafe(migration("0148_invoicing_company_amounts.sql"));
        for (const view of today) await tx.unsafe(view);
      });
    }
    for (const l of await lineAmounts(issued.id)) expect(Number(l.subtotal_company)).toBe(Number(l.base));
    for (const t of await taxAmounts(issued.id)) expect(Number(t.amount_company)).toBe(Number(t.amount));
    // Every peso row of the database, whatever the company: the company amount is the document amount.
    const [drift] = await h.sql<{ n: number }[]>`
      select (select count(*) from invoicing.invoice_lines l join invoicing.invoices i on i.id = l.invoice_id where i.currency = 'COP' and l.subtotal_company <> l.base)
           + (select count(*) from invoicing.invoice_taxes t join invoicing.invoices i on i.id = t.invoice_id where i.currency = 'COP' and t.amount_company <> t.amount)
           + (select count(*) from invoicing.note_lines l join invoicing.notes n on n.id = l.note_id where n.currency = 'COP' and l.subtotal_company <> l.base)
           + (select count(*) from invoicing.note_taxes t join invoicing.notes n on n.id = t.note_id where n.currency = 'COP' and t.amount_company <> t.amount) as n`;
    expect(Number(drift!.n)).toBe(0);
  });

  it("a USD invoice of two lines stores per-line pesos whose sum is total_company; its entry is in USD, balanced in dollars and in pesos", async () => {
    const issued = await usdInvoice();
    const header = await headerOf(issued.id);
    const lines = await lineAmounts(issued.id);
    const taxes = await taxAmounts(issued.id);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(Number(l.subtotal_company)).toBe(round2(Number(l.base) * TRM));
    for (const t of taxes) expect(Number(t.amount_company)).toBe(round2(Number(t.amount) * TRM));
    const pesos = round2([...lines.map((l) => Number(l.subtotal_company)), ...taxes.map((t) => Number(t.amount_company))].reduce((s, n) => s + n, 0));
    expect(Number(header.total_company)).toBe(pesos);

    const [event] = await h.issuedEvent(issued.id);
    // R34-4: the company fields keep their meaning; the document twins are the same names with Doc.
    expect(event!.payload).toMatchObject({ currency: "USD", exchangeRate: TRM, totals: { total: pesos, totalDoc: Number(header.total) } });
    const { entry, debit, credit, debitDoc, creditDoc } = await entryOf(event!.id);
    expect(entry).toMatchObject({ currency: "USD" });
    expect(Number(entry.exchange_rate)).toBe(TRM);
    expect(debit).toBe(pesos);
    expect(credit).toBe(pesos);
    expect(debitDoc).toBe(Number(header.total));
    expect(creditDoc).toBe(Number(header.total));
  });

  it("a COP invoice posts as before: currency COP, rate 1, debit_doc = debit on every line", async () => {
    const draft = await h.run<InvoiceOut>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 2 }] });
    const issued = await h.run<Issued>(h.admin, "invoicing.invoice.issue", { id: draft.id });
    expect(issued.rateWarning).toBeNull();
    const [event] = await h.issuedEvent(issued.id);
    expect(event!.payload).toMatchObject({ currency: "COP", exchangeRate: 1, totals: { total: issued.total, totalDoc: issued.total } });
    const { entry, lines } = await entryOf(event!.id);
    expect(entry.currency).toBe("COP");
    for (const l of lines) expect([l.debit_doc, l.credit_doc]).toEqual([l.debit, l.credit]);
  });
});

describe("old rule copies (R34-5, 0149)", () => {
  it("an edited invoice-issued copy without a currency path posts a USD invoice in pesos only, and the sync raises one recommendation", async () => {
    await setRule(invoiceIssuedRule.name, legacy(invoiceIssuedRule.template as Template), true);
    try {
      const issued = await usdInvoice();
      const header = await headerOf(issued.id);
      const [event] = await h.issuedEvent(issued.id);
      const { entry, lines, debit } = await entryOf(event!.id);
      expect(entry.currency).toBe("COP");
      expect(Number(entry.exchange_rate)).toBe(1);
      expect(debit).toBe(Number(header.total_company));
      for (const l of lines) expect([l.debit_doc, l.credit_doc]).toEqual([l.debit, l.credit]);

      await h.run(h.admin, "accounting.posting_rule.sync_defaults", {});
      await h.run(h.admin, "accounting.posting_rule.sync_defaults", {});
      const recommendations = await h.sql<{ reason: string; status: string; occurrences: number; params: Record<string, { value: unknown }> }[]>`
        select reason, status, occurrences, params from kernel.recommendations
        where company_id = ${h.companyId} and subject_entity = 'accounting.posting_rule' and reason = 'rule_without_currency'`;
      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]).toMatchObject({ status: "new", params: { rule: { value: invoiceIssuedRule.name } } });
      // The edited copy is the admin's: the sync never rewrites it.
      expect(await ruleTemplate(invoiceIssuedRule.name)).toEqual(legacy(invoiceIssuedRule.template as Template));
    } finally {
      await setRule(invoiceIssuedRule.name, invoiceIssuedRule.template, false);
    }
  });

  it("0149 rewrites every unedited invoicing copy still without a currency path to the shipped rule, and can run twice", async () => {
    for (const rule of RULES) await setRule(rule.name, legacy(rule.template as Template), false);
    await setRule(noteDebitRule.name, legacy(noteDebitRule.template as Template), true);
    for (let run = 0; run < 2; run++) await h.sql.begin((tx) => tx.unsafe(migration("0149_invoicing_rules_currency.sql")));
    for (const rule of [invoiceIssuedRule, noteAnnulmentRule, noteCreditRule]) expect(await ruleTemplate(rule.name), rule.name).toEqual(rule.template);
    expect(await ruleTemplate(noteDebitRule.name)).toEqual(legacy(noteDebitRule.template as Template));
    await setRule(noteDebitRule.name, noteDebitRule.template, false);
  });
});

describe("notes of a USD invoice (OD-7, FX §9)", () => {
  it("a credit note takes the invoice's rate and posts at it, in USD, with no exchange difference", async () => {
    const invoice = await usdInvoice(4100);
    // A note corrects an invoice the DIAN accepted (Task 18): the verdict is set as the mock would leave it.
    await h.sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update invoicing.invoices set dian_status = 'accepted' where id = ${invoice.id}`;
    });
    const [line] = await h.sql<{ id: string }[]>`select id from invoicing.invoice_lines where invoice_id = ${invoice.id} order by line_no limit 1`;
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.note.create", { invoiceId: invoice.id, kind: "credit", concept: "1", reason: "Devolución parcial", lines: [{ invoiceLineId: line!.id, qty: 1 }] });
    await h.run(h.admin, "invoicing.note.issue", { id: draft.id });
    const [note] = await h.sql<{ exchange_rate: string; total: string; total_company: string }[]>`select exchange_rate::text, total::text, total_company::text from invoicing.notes where id = ${draft.id}`;
    expect(Number(note!.exchange_rate)).toBe(4100);
    const noteLines = await h.sql<{ base: string; subtotal_company: string }[]>`select base::text, subtotal_company::text from invoicing.note_lines where note_id = ${draft.id}`;
    for (const l of noteLines) expect(Number(l.subtotal_company)).toBe(round2(Number(l.base) * 4100));
    const noteTaxes = await h.sql<{ amount: string; amount_company: string }[]>`select amount::text, amount_company::text from invoicing.note_taxes where note_id = ${draft.id}`;
    for (const t of noteTaxes) expect(Number(t.amount_company)).toBe(round2(Number(t.amount) * 4100));

    const [event] = await h.sql<{ id: string; payload: Record<string, unknown> }[]>`
      select id, payload from kernel.outbox where company_id = ${h.companyId} and event = 'invoicing.note.issued' and payload->>'noteId' = ${draft.id}`;
    expect(event!.payload).toMatchObject({ currency: "USD", exchangeRate: 4100, totals: { total: -Number(note!.total_company), totalDoc: -Number(note!.total) } });
    const { entry, lines, debit, credit, debitDoc, creditDoc } = await entryOf(event!.id);
    expect(entry.currency).toBe("USD");
    expect(Number(entry.exchange_rate)).toBe(4100);
    expect([debit, credit]).toEqual([Number(note!.total_company), Number(note!.total_company)]);
    expect([debitDoc, creditDoc]).toEqual([Number(note!.total), Number(note!.total)]);
    // Every line at the invoice's rate: a document amount and its company amount, none of them a peso-only (exchange difference) line.
    for (const l of lines) expect(Number(l.debit_doc) + Number(l.credit_doc)).toBeGreaterThan(0);
  });
});

describe("the rate against the TRM (R34-8, item 123)", () => {
  it("a rate 1 % off the TRM of the issue date issues with rateWarning; the TRM's own rate issues with null", async () => {
    const off = round2(TRM * 1.01);
    expect((await usdInvoice(off)).rateWarning).toEqual({ trm: TRM, rate: off });
    expect((await usdInvoice(TRM)).rateWarning).toBeNull();
    // Within 0,005 %: no warning (a typed rounding of the TRM).
    expect((await usdInvoice(round2(TRM + 0.2))).rateWarning).toBeNull();
  });
});

describe("visibility of the company amounts (rule 14, FX §10)", () => {
  it("a viewer whose role masks the line's base or the tax's amount reads the company twin masked; unmasked, it reads the stored pesos", async () => {
    const issued = await usdInvoice();
    const read = () => withClaims(h.sql, h.member.claims, async (tx) => ({
      lines: await tx<{ subtotal_company: string | null }[]>`select subtotal_company::text from invoicing.v_invoice_lines where invoice_id = ${issued.id}`,
      taxes: await tx<{ amount_company: string | null }[]>`select amount_company::text from invoicing.v_invoice_taxes where invoice_id = ${issued.id}`,
    }));
    const open = await read();
    expect(open.lines.length).toBeGreaterThan(0);
    expect(open.lines.every((l) => l.subtotal_company !== null)).toBe(true);
    for (const [entity, field] of [["invoicing.invoice_line", "base"], ["invoicing.invoice_tax", "amount"]] as const) {
      await h.sql`insert into kernel.field_permissions (company_id, role_id, entity, field, mode) values (${h.companyId}, ${h.memberRoleId}, ${entity}, ${field}, 'masked')`;
    }
    try {
      const masked = await read();
      expect(masked.lines.map((l) => l.subtotal_company)).toEqual(open.lines.map(() => null));
      expect(masked.taxes.map((t) => t.amount_company)).toEqual(open.taxes.map(() => null));
    } finally {
      await h.sql`delete from kernel.field_permissions where company_id = ${h.companyId} and role_id = ${h.memberRoleId}`;
    }
  });
});
