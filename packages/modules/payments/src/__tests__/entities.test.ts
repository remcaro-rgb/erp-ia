import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeEntry, defineEntity, kernelModule, loadModules, maskedViewSql, menuItemsOf, Registry, uncoveredMenuProcesses, type RuleTemplate } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import receivedFixture from "../../../accounting/src/rules/fixtures/payment-received.json" with { type: "json" };
import voidedFixture from "../../../accounting/src/rules/fixtures/payment-voided.json" with { type: "json" };
import accountingReceived from "../../../accounting/src/rules/defaults/payment-received.json" with { type: "json" };
import accountingVoided from "../../../accounting/src/rules/defaults/payment-voided.json" with { type: "json" };
import { payments, PAYMENTS_ENTITIES, PAYMENTS_POSTING_RULES } from "../index";
import { receiptTotals, receivedPayload, voidedPayload } from "../processes/receipt";

// The payments manifest (plan 2B Task 21, design §8 and §8.1 step 7): two maestros (medios de pago, cajas), the recibo de caja (documento
// that posts) with its allocations, the events the 2A rules post (payments.received, payments.payment.voided), the rules it ships (one copy
// per company: byte-identical to accounting's defaults) and the masked views of migration 0109 generated from the entity definitions.

const migration = readFileSync(new URL("../../../../../supabase/migrations/0109_payments_core.sql", import.meta.url), "utf8");

const loaded = () => {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, payments]);
  return registry;
};

describe("payments manifest", () => {
  it("depends on core, declares the four menu sections and its features, emits the 2A events", () => {
    expect(payments.id).toBe("payments");
    expect(payments.dependsOn).toEqual(["core"]);
    expect(payments.navigation.map((n) => n.id)).toEqual(["payments.maestros", "payments.documentos", "payments.reportes", "payments.parametros"]);
    expect(payments.features.map((f) => f.id)).toEqual(["payments.methods", "payments.receipts"]);
    expect(payments.features.flatMap((f) => f.entities).sort()).toEqual(PAYMENTS_ENTITIES.map((e) => e.id).sort());
    expect(payments.events.emits).toEqual(["payments.received", "payments.payment.voided"]);
  });

  it("types the methods and cash boxes as maestros, the receipt as a documento that numbers on save, its allocations as lines", () => {
    expect(Object.fromEntries(PAYMENTS_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "payments.method": "maestro",
      "payments.cash_box": "maestro",
      "payments.receipt": "documento",
      "payments.receipt_allocation": "lines",
    });
    const receipt = PAYMENTS_ENTITIES.find((e) => e.id === "payments.receipt")!;
    expect(receipt.typed).toMatchObject({ numbering: "on_save", lines: { entity: "payments.receipt_allocation", parentField: "receipt_id" } });
    expect(receipt.processIds).toEqual({ create: "payments.payment.receive" });
    // A copy keeps only the customer, the method and the caja: no money, number, reference or state of the original (fix round 1).
    expect(receipt.cloneReset).toEqual(expect.arrayContaining(["number", "amount", "applied", "withholding_total", "advance", "reference", "method_code", "applied_at", "voided_at", "void_reason"]));
    for (const entity of PAYMENTS_ENTITIES) {
      const resolved = defineEntity(entity);
      expect(resolved.label).toBe(`entity.${entity.id}`);
      for (const field of resolved.fields) expect(field.label).toBe(`field.${entity.id}.${field.name}`);
    }
  });

  it("loads with its processes, each in a feature and under a menu item; the void is step-up, receive is a write the assistant confirms", () => {
    const registry = loaded();
    const ids = registry.processes({ module: "payments" }).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([
      "payments.method.create", "payments.method.update", "payments.method.consult",
      "payments.cash_box.create", "payments.cash_box.update", "payments.cash_box.consult",
      "payments.payment.receive", "payments.payment.void", "payments.receipt.consult", "payments.receipt_allocation.consult",
    ]));
    const module = registry.module("payments");
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    const receive = registry.processes({ module: "payments" }).find((p) => p.id === "payments.payment.receive")!;
    const voiding = registry.processes({ module: "payments" }).find((p) => p.id === "payments.payment.void")!;
    expect(receive.kind).toBe("create");
    expect(receive.sensitivity ?? "normal").toBe("normal");
    expect(voiding.sensitivity).toBe("step-up");
  });

  it("menu: Medios de pago and Cajas in Maestros, Recibos de caja in Documentos (pages come later)", () => {
    const rows = menuItemsOf(loaded().module("payments")).filter((r) => r.href && !r.href.startsWith("/payments/parametros/"));
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["payments.methods", "payments.maestros", "/payments/methods"],
      ["payments.cash_boxes", "payments.maestros", "/payments/cash-boxes"],
      ["payments.receipts", "payments.documentos", "/payments/receipts"],
    ]);
  });

  it("ships the 2A rules unchanged from accounting's defaults (one copy per company): the receipt and its reversal", () => {
    expect(PAYMENTS_POSTING_RULES).toEqual([accountingReceived, accountingVoided]);
    expect(PAYMENTS_POSTING_RULES.map((r) => [r.event, r.name, r.journalCode])).toEqual([
      ["payments.received", "Recibo de caja", "RC"],
      ["payments.payment.voided", "Anulación de recibo de caja", "RC"],
    ]);
  });
});

describe("the payments.received payload", () => {
  const customer = { partyId: "0192b4c0-0000-7000-8000-00000000c001", legalName: "Tiendas D1 S.A.S." };
  const invoiceA = "0192b4c0-0000-7000-8000-00000000a001";
  const invoiceB = "0192b4c0-0000-7000-8000-00000000a002";
  const base = {
    receiptId: "0192b4c0-0000-7000-8000-00000000f005", number: "RC-310", date: "2026-11-05", methodKind: "transfer", methodCode: "BANCOLOMBIA", methodId: "0192b4c0-0000-7000-8000-00000000e001",
    cashBoxId: null, reference: "TRF-1", currency: "COP", exchangeRate: 1, customer,
  };

  it("carries every key of the 2A fixture with the same shape, and composes the fixture's entry (Dr bank 1.155.340 + withholdings 34.660 / Cr receivable 1.190.000)", () => {
    const payload = receivedPayload({
      ...base,
      amount: 1155340,
      allocations: [{
        invoiceId: invoiceA, invoiceNumber: "FE-1", amount: 1190000,
        withholdings: [
          { kind: "income", code: "RTEFTE_COMPRAS_2_5", rate: 2.5, base: 1000000, amount: 25000 },
          { kind: "ica", code: "RTEICA_BOGOTA_0_966", rate: 0.966, base: 1000000, amount: 9660 },
        ],
      }],
    });
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(payload)).toEqual(expect.arrayContaining(keys(receivedFixture)));
    expect(keys(payload.customer)).toEqual(keys(receivedFixture.customer));
    expect(keys(payload.withholdings)).toEqual(keys(receivedFixture.withholdings));
    expect(keys(payload.withholdings.income[0]!)).toEqual(expect.arrayContaining(keys(receivedFixture.withholdings.income[0]!)));
    // The cash line's dimension is the method's KIND (controller ruling, fix round 1): every kind is mapped by the pack, a free-text code is not.
    expect(payload).toMatchObject({ date: "2026-11-05", number: "RC-310", paymentId: base.receiptId, method: "transfer", methodCode: "BANCOLOMBIA", amount: 1155340, applied: 1190000, advance: 0, advances: [], customer });
    expect(payload.withholdings).toMatchObject({ income: [{ code: "RTEFTE_COMPRAS_2_5", rate: 2.5, base: 1000000, amount: 25000, invoiceId: invoiceA }], vat: [], ica: [{ code: "RTEICA_BOGOTA_0_966", amount: 9660 }] });
    expect(payload.allocations).toEqual([{ invoiceId: invoiceA, invoiceNumber: "FE-1", amount: 1190000, cash: 1155340, withholdingTotal: 34660, withholdings: expect.any(Array) }]);

    const lines = (payloadIn: unknown) => {
      const composed = composeEntry(accountingReceived.template as RuleTemplate, { id: "e1", event: "payments.received", payload: payloadIn, createdAt: new Date(), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
      if (!composed.ok) throw new Error(composed.detail);
      return composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany, l.dimension ?? null, l.taxCode ?? null]);
    };
    const expected = [
      ["cash", "debit", 1155340, "payment_method:transfer", null],
      ["withholding_income_suffered", "debit", 25000, null, "RTEFTE_COMPRAS_2_5"],
      ["withholding_ica_suffered", "debit", 9660, null, "RTEICA_BOGOTA_0_966"],
      ["receivable", "credit", 1190000, null, null],
    ];
    expect(lines(payload)).toEqual(expected);
    // The 2A fixture itself still composes the same entry with the shipped rule (no advance in it).
    expect(lines(receivedFixture)).toEqual(expected);
  });

  it("one receipt over two invoices with money left over: the remainder is a customer advance (Cr customer_advances)", () => {
    const payload = receivedPayload({
      ...base,
      amount: 500000,
      allocations: [
        { invoiceId: invoiceA, invoiceNumber: "FE-1", amount: 200000, withholdings: [{ kind: "income", code: "RTEFTE", rate: 2.5, base: 100000, amount: 2500 }] },
        { invoiceId: invoiceB, invoiceNumber: "FE-2", amount: 100000, withholdings: [] },
      ],
    });
    expect(payload).toMatchObject({ amount: 500000, applied: 300000, advance: 202500, advances: [{ amount: 202500 }] });
    const composed = composeEntry(accountingReceived.template as RuleTemplate, { id: "e1", event: "payments.received", payload, createdAt: new Date(), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany])).toEqual([
      ["cash", "debit", 500000], ["withholding_income_suffered", "debit", 2500], ["receivable", "credit", 300000], ["customer_advances", "credit", 202500],
    ]);
  });

  it("the void payload carries the 2A fixture's keys and the allocations it gives back", () => {
    const payload = voidedPayload({ receiptId: base.receiptId, number: "RC-310", date: "2026-11-06", reason: "Consignación devuelta", partyId: customer.partyId, allocations: [{ invoiceId: invoiceA, amount: 1190000 }] });
    expect(Object.keys(payload).sort()).toEqual(expect.arrayContaining(Object.keys(voidedFixture).sort()));
    expect(payload).toEqual({ date: "2026-11-06", number: "RC-310", paymentId: base.receiptId, reason: "Consignación devuelta", partyId: customer.partyId, allocations: [{ invoiceId: invoiceA, amount: 1190000 }] });
  });
});

describe("receipt totals", () => {
  const alloc = (amount: number, withholdings: { kind: "income" | "vat" | "ica"; code: string; rate: number; base: number; amount: number }[] = []) => ({ invoiceId: "i", invoiceNumber: "FE-1", amount, withholdings });

  it("withholdings reduce the cash but the invoice is settled by the full amount", () => {
    expect(receiptTotals(97500, [alloc(100000, [{ kind: "income", code: "RTEFTE", rate: 2.5, base: 100000, amount: 2500 }])])).toEqual({
      ok: true, applied: 100000, withholdingTotal: 2500, cashApplied: 97500, advance: 0, lines: [{ cash: 97500, withholdingTotal: 2500 }],
    });
  });

  it("refuses money short of what is applied in cash, a withholding that does not match its base and rate, and withholdings above the allocation", () => {
    expect(receiptTotals(90000, [alloc(100000)])).toMatchObject({ ok: false, code: "cash_short" });
    expect(receiptTotals(97000, [alloc(100000, [{ kind: "income", code: "RTEFTE", rate: 2.5, base: 100000, amount: 3000 }])])).toMatchObject({ ok: false, code: "invalid_withholding" });
    expect(receiptTotals(0, [alloc(1000, [{ kind: "income", code: "RTEFTE", rate: 10, base: 20000, amount: 2000 }])])).toMatchObject({ ok: false, code: "invalid_withholding" });
    expect(receiptTotals(0, [])).toMatchObject({ ok: false, code: "nothing_received" });
  });

  it("a withholding may differ from base × rate by the rounding to the peso ($ 0,50), not more", () => {
    const w = (amount: number) => [alloc(100000, [{ kind: "ica" as const, code: "RTEICA", rate: 0.966, base: 100000, amount }])];
    // 100.000 × 0,966 % = 966,00
    expect(receiptTotals(100000 - 966.5, w(966.5))).toMatchObject({ ok: true });
    expect(receiptTotals(100000 - 965.5, w(965.5))).toMatchObject({ ok: true });
    expect(receiptTotals(100000 - 967, w(967))).toMatchObject({ ok: false, code: "invalid_withholding" });
    expect(receiptTotals(100000 - 965, w(965))).toMatchObject({ ok: false, code: "invalid_withholding" });
  });
});

describe("payments masked views, migration 0109", () => {
  for (const entity of PAYMENTS_ENTITIES) {
    it(`payments.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      expect(migration).toContain(maskedViewSql(defineEntity(entity)));
    });
  }
});

describe("the receipt's print template (plan 2B Task 24b)", () => {
  it("prints the receipt's header (customer, method, date, reference, money) and what it applied to each invoice", async () => {
    const print = (await import("../print")) as Record<string, unknown>;
    const receiptRecordTemplate = print.receiptRecordTemplate as ((p: { title: string }) => { blocks: { kind: string; value?: string; columns?: string[] }[] }) | undefined;
    expect(receiptRecordTemplate).toBeTypeOf("function");
    expect(payments.printTemplates?.["payments.receipt"]?.record).toBe(receiptRecordTemplate);
    const t = receiptRecordTemplate!({ title: "Recibo de caja" });
    expect(t.blocks.filter((b) => b.kind === "field").map((b) => b.value)).toEqual(["number", "party_id", "date", "method_id", "cash_box_id", "reference", "amount", "applied", "withholding_total", "advance", "notes"]);
    expect(t.blocks.find((b) => b.kind === "lines")?.columns).toEqual(["line_no", "invoice_number", "amount", "withholding_total", "cash_amount"]);
  });
});
