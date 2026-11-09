import { describe, expect, it } from "vitest";
import { INVOICE_READY_PARTIES, PARTIES } from "../demo/data";
import { ANDRES, DEMO_ROLE_IDS, LAURA, MARCELA } from "../demo/accounts";
import {
  ADJUSTMENTS, ANNULMENT_NOTES, annulmentAlreadyPosted, annulmentPayload, documentId, BUSINESS_UNITS, COGS, SAMPLE_COMPROBANTES, COST_CENTERS, CREDIT_NOTES, ITEMS, INVOICES, OPEN_AUXILIARIES, OPENING_LINES, TOSTADORA, TRILLADORA, ELECTRIC,
  type Node,
} from "../demo/accounting";

// The demo ledger's data (Task 31): what scripts/demo/accounting.ts sends to the accounting processes must be coherent before it
// reaches them: balanced opening, 40 documents in the open months, masters whose parents exist, parties that are in the demo data.

const partyKinds = new Map(PARTIES.map((p) => [p.documentNumber, p.kind as string[]]));

describe("the demo accountant", () => {
  it("is Andrés Rojas, a contador with a Colombian mobile and no second step", () => {
    expect(ANDRES).toMatchObject({ email: "andres@demo.local", fullName: "Andrés Rojas", roles: ["contador"] });
    expect(ANDRES.mobile).toMatch(/^3\d{9}$/);
    expect(ANDRES.totpSecret).toBeUndefined();
    expect(DEMO_ROLE_IDS.contador).toBeDefined();
    expect(new Set([LAURA.email, MARCELA.email, ANDRES.email]).size).toBe(3);
  });
});

describe("the demo ledger data", () => {
  it("opens with balanced balances, parties where the accounts ask for them, dated on the first day of the ledger", () => {
    const debit = OPENING_LINES.reduce((sum, l) => sum + (("debit" in l ? l.debit : 0) as number), 0);
    const credit = OPENING_LINES.reduce((sum, l) => sum + (("credit" in l ? l.credit : 0) as number), 0);
    expect(debit).toBe(credit);
    for (const line of OPENING_LINES) {
      const party = "partyDocument" in line ? line.partyDocument : undefined;
      // Groups 13 and 22 of the PUC (clientes, proveedores) carry a party.
      if (/^(13|22)/.test(line.accountCode)) expect(party, line.accountCode).toBeDefined();
      if (party) expect(partyKinds.has(party), party).toBe(true);
    }
  });

  it("has 15 invoices, their receipts, 2 credit notes, 7 cost postings, 2 adjustments, 1 void and 1 annulment note: 40 documents in January to October", () => {
    const receipts = INVOICES.filter((i) => i.receipt).length;
    expect(INVOICES).toHaveLength(15);
    expect(receipts).toBe(12);
    // 15 invoices + 12 receipts + 2 notes + 7 cost postings + 2 adjustments + 1 void (the receipt of FE-1013) + 1 annulment note (NC-303, of FE-1015).
    expect(INVOICES.length + receipts + CREDIT_NOTES.length + COGS.length + ADJUSTMENTS.length + 1 + ANNULMENT_NOTES.length).toBe(40);
    expect(new Set(INVOICES.map((i) => i.number)).size).toBe(15);
    for (const document of [...INVOICES, ...CREDIT_NOTES, ...COGS, ...ADJUSTMENTS]) {
      expect(document.date >= "2026-01-01" && document.date <= "2026-10-31", document.date).toBe(true);
    }
    for (const invoice of INVOICES) {
      expect(partyKinds.get(invoice.customer), invoice.number).toContain("customer");
      expect(invoice.beverages + invoice.food, invoice.number).toBeGreaterThan(0);
    }
    for (const note of CREDIT_NOTES) expect(partyKinds.get(note.customer), note.number).toContain("customer");
    for (const supplier of [TRILLADORA, TOSTADORA, ELECTRIC]) expect(partyKinds.get(supplier)).toContain("supplier");
  });

  it("annuls FE-1015 with the credit note of annulment NC-303: next number, an open October date, the invoice's own amounts", () => {
    expect(ANNULMENT_NOTES.map((n) => n.invoice)).toEqual(["FE-1015"]);
    const numbers = [...CREDIT_NOTES, ...ANNULMENT_NOTES].map((n) => n.number);
    expect(numbers).toEqual(["NC-301", "NC-302", "NC-303"]);
    const note = ANNULMENT_NOTES[0]!;
    const invoice = INVOICES.find((i) => i.number === note.invoice)!;
    expect(note.date >= invoice.date && note.date <= "2026-10-31").toBe(true);
    const payload = annulmentPayload(note, invoice, { noteId: documentId("e", CREDIT_NOTES.length + 1), invoiceId: documentId("a", INVOICES.indexOf(invoice) + 1), customer: { partyId: "p", legalName: "SOL DEL CARIBE" }, costCenterId: "cc" });
    // The very payload of invoicing.note.issued of the real void path (processes/note.ts): kind credit, annulment, concept 2, negative signed amounts.
    expect(payload).toMatchObject({ number: "NC-303", kind: "credit", annulment: true, reasonCode: "2", invoiceNumber: "FE-1015", date: "2026-10-20" });
    const base = invoice.beverages + invoice.food;
    expect(base).toBe(3_000_000);
    // Task 34.4 (R34-4): in pesos, each amount's document twin equals it, with currency COP at rate 1.
    expect(payload).toMatchObject({ currency: "COP", exchangeRate: 1 });
    expect(payload.totals).toEqual({ total: -3_570_000, totalDoc: -3_570_000 });
    expect(payload.lines).toEqual([
      { subtotal: -invoice.beverages, subtotalDoc: -invoice.beverages, categoryId: "bebidas", costCenterId: "cc" },
      { subtotal: -invoice.food, subtotalDoc: -invoice.food, categoryId: "comida", costCenterId: "cc" },
    ]);
    expect(payload.taxes).toEqual([{ code: "IVA19", rate: 19, amount: -570_000, amountDoc: -570_000, base: -base }]);
    // Balanced: the total is the lines plus the tax.
    expect(-(payload.totals as { total: number }).total).toBe(base + 570_000);
  });

  it("names cost centers and business units that exist, and masters whose groups come before their leaves", () => {
    const centers = new Set(COST_CENTERS.map((n) => n.code));
    const units = new Set(BUSINESS_UNITS.map((n) => n.code));
    for (const document of [...INVOICES, ...CREDIT_NOTES, ...COGS, ...ADJUSTMENTS]) expect(centers.has(document.costCenter), document.costCenter).toBe(true);
    for (const invoice of INVOICES) expect(units.has(invoice.businessUnit), invoice.businessUnit).toBe(true);
    for (const nodes of [COST_CENTERS, OPEN_AUXILIARIES, ITEMS, BUSINESS_UNITS] as Node[][]) {
      const seen = new Set<string>();
      for (const node of nodes) {
        if (node.parent) expect(nodes.find((n) => n.code === node.parent)?.kind, node.code).toBe("group");
        if (node.parent) expect(seen.has(node.parent), `${node.code} after ${node.parent}`).toBe(true);
        seen.add(node.code);
      }
    }
    expect(COST_CENTERS.filter((n) => n.parent === "TIE").map((n) => n.name)).toEqual(["Tienda Chapinero", "Tienda Usaquén"]);
  });

  it("leaves some documents open for the aging report: one invoice never collected and one half collected", () => {
    expect(INVOICES.filter((i) => !i.receipt).map((i) => i.number)).toEqual(["FE-1008", "FE-1014", "FE-1015"]);
    expect(INVOICES.find((i) => i.number === "FE-1012")?.receipt?.share).toBe(0.5);
  });
});

// Rule 10, design §22.22 (2026-11-02): receivables (1305) and payables (2205) only take invoice-ready parties, so every party
// the demo ledger puts on them must get its RUT (and Cámara de Comercio) from the seed. Before this test the suppliers on the
// opening payables had no files and `DEMO_SEED=1 pnpm db:seed` stopped in setUpOpening.
describe("the demo ledger's parties on receivables and payables", () => {
  const gated = (code: string) => /^(1305|2205)/.test(code);
  const ready = new Set(INVOICE_READY_PARTIES);

  it("are all invoice-ready parties of the demo data", () => {
    const used = new Set<string>();
    for (const line of OPENING_LINES) if ("partyDocument" in line && gated(line.accountCode)) used.add(line.partyDocument!);
    for (const invoice of INVOICES) used.add(invoice.customer);
    for (const note of CREDIT_NOTES) used.add(note.customer);
    for (const c of SAMPLE_COMPROBANTES) for (const line of c.lines) if (line.partyDocument && gated(line.accountCode)) used.add(line.partyDocument);
    for (const document of used) expect(ready.has(document), document).toBe(true);
    // Some parties stay without files so the first recommendation has something to point out.
    expect(PARTIES.length - ready.size).toBeGreaterThan(5);
  });

  it("the interest income on 421005 names its tercero, the bank (exógena 1007 refuses an income with none)", () => {
    const lines = SAMPLE_COMPROBANTES.flatMap((c) => c.lines).filter((l) => l.accountCode === "421005");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.partyDocument).toBe("890903938");
  });

  it("the sample comprobantes are balanced, carry parties on groups 13 and 22 to 25 and cost centers on classes 4 to 7", () => {
    const centers = new Set(COST_CENTERS.map((n) => n.code));
    expect(SAMPLE_COMPROBANTES.length).toBeGreaterThanOrEqual(4);
    for (const c of SAMPLE_COMPROBANTES) {
      const debit = c.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const credit = c.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
      expect(debit, c.description).toBe(credit);
      expect(c.date >= "2026-10-01" && c.date <= "2026-10-31", c.date).toBe(true);
      for (const line of c.lines) {
        expect(Number.isInteger(line.debit ?? line.credit), `${c.description} ${line.accountCode}`).toBe(true);
        if (/^(13|2[2-5])/.test(line.accountCode)) expect(partyKinds.has(line.partyDocument ?? ""), `${c.description} ${line.accountCode}`).toBe(true);
        if (/^[4-7]/.test(line.accountCode)) expect(centers.has(line.costCenter ?? ""), `${c.description} ${line.accountCode}`).toBe(true);
      }
    }
  });
});

describe("the annulment of FE-1015 on a database seeded before Task 53 (review F-6.1)", () => {
  it("is skipped when the outbox already holds invoicing.invoice.voided for the invoice, and sent otherwise", () => {
    const note = ANNULMENT_NOTES[0]!;
    expect(note.invoice).toBe("FE-1015");
    expect(annulmentAlreadyPosted(note.invoice, new Set(["FE-1015"]))).toBe(true);
    expect(annulmentAlreadyPosted(note.invoice, new Set(["FE-1010"]))).toBe(false);
    expect(annulmentAlreadyPosted(note.invoice, new Set())).toBe(false);
  });
});
