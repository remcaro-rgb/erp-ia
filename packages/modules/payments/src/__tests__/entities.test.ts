import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { composeEntry, defineEntity, kernelModule, loadModules, maskedViewSql, menuItemsOf, Registry, uncoveredMenuProcesses, type RuleTemplate } from "@erp/kernel";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import receivedFixture from "../../../accounting/src/rules/fixtures/payment-received.json" with { type: "json" };
import voidedFixture from "../../../accounting/src/rules/fixtures/payment-voided.json" with { type: "json" };
import accountingReceived from "../../../accounting/src/rules/defaults/payment-received.json" with { type: "json" };
import accountingVoided from "../../../accounting/src/rules/defaults/payment-voided.json" with { type: "json" };
import accountingAdvanceApplied from "../../../accounting/src/rules/defaults/advance-applied.json" with { type: "json" };
import accountingAdvanceUnapplied from "../../../accounting/src/rules/defaults/advance-unapplied.json" with { type: "json" };
import { payments, PAYMENTS_ENTITIES, PAYMENTS_POSTING_RULES } from "../index";
import { receiptTotals, receivedPayload, voidedPayload } from "../processes/receipt";
import { ACCOUNTING_DEFAULT_RULES } from "../../../accounting/src/rules/defaults";

// The payments manifest (plan 2B Task 21, design §8 and §8.1 step 7): two maestros (medios de pago, cajas), the recibo de caja (documento
// that posts) with its allocations, the events the 2A rules post (payments.received, payments.payment.voided), the rules it ships (one copy
// per company: byte-identical to accounting's defaults) and the masked views of migration 0109 generated from the entity definitions.

const migrationOf = (file: string) => readFileSync(new URL(`../../../../../supabase/migrations/${file}`, import.meta.url), "utf8");
const migration = migrationOf("0109_payments_core.sql");
/** The masked views of the application entities were pasted in migration 0137 (plan 2B.2 Task 36), then in 0152 (below). */
const ADVANCE_ENTITIES = ["payments.advance_application", "payments.advance_application_line"];
/** The views re-created with the foreign-currency columns are pasted in migration 0150 (plan 2B.2 Task 34.5). */
const fxMigration = migrationOf("0150_payments_foreign_currency.sql");
const FX_ENTITIES = ["payments.method", "payments.receipt_allocation"];
/** The application views re-created with the advances' rate and pesos are pasted in migration 0152 (plan 2B.2 Task 34.6). */
const advanceFxMigration = migrationOf("0152_payments_advance_applications_currency.sql");

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
    expect(payments.features[1]!.processes).toEqual(expect.arrayContaining(["payments.advance.apply", "payments.advance.undo", "payments.advance.open", "payments.advance_application.consult", "payments.advance_application_line.consult", "payments.advance_application.delete"]));
    expect(payments.features.flatMap((f) => f.entities).sort()).toEqual(PAYMENTS_ENTITIES.map((e) => e.id).sort());
    expect(payments.events.emits).toEqual(["payments.received", "payments.payment.voided", "payments.advance.applied", "payments.advance.unapplied"]);
  });

  it("types the methods and cash boxes as maestros, the receipt as a documento that numbers on save, its allocations as lines", () => {
    expect(Object.fromEntries(PAYMENTS_ENTITIES.map((e) => [e.id, e.entityType]))).toEqual({
      "payments.method": "maestro",
      "payments.cash_box": "maestro",
      "payments.receipt": "documento",
      "payments.receipt_allocation": "lines",
      "payments.advance_application": "documento",
      "payments.advance_application_line": "lines",
    });
    const application = PAYMENTS_ENTITIES.find((e) => e.id === "payments.advance_application")!;
    expect(application.typed).toMatchObject({ numbering: "on_save", lines: { entity: "payments.advance_application_line", parentField: "application_id" } });
    expect(application.processIds).toEqual({ create: "payments.advance.apply" });
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
      "payments.advance.apply", "payments.advance.undo", "payments.advance.open", "payments.advance_application.consult", "payments.advance_application_line.consult", "payments.advance_application.delete",
    ]));
    const module = registry.module("payments");
    expect(module.features.flatMap((f) => f.processes).sort()).toEqual(module.processes.map((p) => p.id).sort());
    expect(uncoveredMenuProcesses(module)).toEqual([]);
    const receive = registry.processes({ module: "payments" }).find((p) => p.id === "payments.payment.receive")!;
    const voiding = registry.processes({ module: "payments" }).find((p) => p.id === "payments.payment.void")!;
    expect(receive.kind).toBe("create");
    expect(receive.sensitivity ?? "normal").toBe("normal");
    expect(voiding.sensitivity).toBe("step-up");
    // Task 36: applying an advance has no step-up (the receipt's creation has none), undoing it has (the receipt's void has).
    const byId = (id: string) => registry.processes({ module: "payments" }).find((p) => p.id === id)!;
    expect(byId("payments.advance.apply").kind).toBe("create");
    expect(byId("payments.advance.apply").sensitivity ?? "normal").toBe("normal");
    expect(byId("payments.advance.undo").kind).toBe("update");
    expect(byId("payments.advance.undo").sensitivity).toBe("step-up");
    expect(byId("payments.advance.open").kind).toBe("consult");
  });

  it("menu: Medios de pago and Cajas in Maestros, Recibos de caja and Aplicaciones de anticipo in Documentos", () => {
    const rows = menuItemsOf(loaded().module("payments")).filter((r) => r.href && !r.href.startsWith("/payments/parametros/"));
    expect(rows.map((r) => [r.navKey, r.parentKey, r.href])).toEqual([
      ["payments.methods", "payments.maestros", "/payments/methods"],
      ["payments.cash_boxes", "payments.maestros", "/payments/cash-boxes"],
      ["payments.receipts", "payments.documentos", "/payments/receipts"],
      ["payments.advance_applications", "payments.documentos", "/payments/advance-applications"],
    ]);
  });

  it("ships the 2A rules unchanged from accounting's defaults (one copy per company): the receipt and its reversal", () => {
    expect(PAYMENTS_POSTING_RULES).toEqual([accountingReceived, accountingVoided, accountingAdvanceApplied, accountingAdvanceUnapplied]);
    expect(PAYMENTS_POSTING_RULES.map((r) => [r.event, r.name, r.journalCode])).toEqual([
      ["payments.received", "Recibo de caja", "RC"],
      ["payments.payment.voided", "Anulación de recibo de caja", "RC"],
      ["payments.advance.applied", "Aplicación de anticipo", "RC"],
      ["payments.advance.unapplied", "Anulación de aplicación de anticipo", "RC"],
    ]);
    // Byte for byte: the JSON files are the same text (the sync matches by event and name, never adds one twice).
    for (const file of ["advance-applied.json", "advance-unapplied.json"]) {
      expect(readFileSync(new URL(`../rules/${file}`, import.meta.url), "utf8")).toBe(readFileSync(new URL(`../../../accounting/src/rules/defaults/${file}`, import.meta.url), "utf8"));
    }
    expect(ACCOUNTING_DEFAULT_RULES).toEqual(expect.arrayContaining([accountingAdvanceApplied, accountingAdvanceUnapplied]));
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
    expect(payload.allocations).toEqual([{
      invoiceId: invoiceA, invoiceNumber: "FE-1", currency: "COP", amount: 1190000, amountReceipt: 1190000, amountCompany: 1190000, cash: 1155340, withholdingTotal: 34660,
      withholdings: expect.any(Array), fx: { gain: 0, loss: 0 },
    }]);
    // R34-4: a peso receipt carries its document twins equal to its company amounts.
    expect(payload).toMatchObject({ currency: "COP", exchangeRate: 1, amountDoc: 1155340, appliedDoc: 1190000 });

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

  it("a USD receipt at 4.000 of a USD invoice carried at 4.100: company amounts at the receipt's rate, the receivable at the invoice's, the loss per allocation (FX §5)", () => {
    const payload = receivedPayload({
      ...base, currency: "USD", exchangeRate: 4000, amount: 1500,
      allocations: [{ invoiceId: invoiceA, invoiceNumber: "FE-1", currency: "USD", amount: 1000, amountReceipt: 1000, amountCompany: 4100000, withholdings: [] }],
    });
    expect(payload).toMatchObject({ currency: "USD", exchangeRate: 4000, amount: 6000000, amountDoc: 1500, applied: 4100000, appliedDoc: 1000, advance: 500, advances: [{ amount: 2000000, amountDoc: 500 }] });
    expect(payload.allocations[0]).toMatchObject({ amountCompany: 4100000, fx: { gain: 0, loss: 100000 } });
    const composed = composeEntry(accountingReceived.template as RuleTemplate, { id: "e1", event: "payments.received", payload, createdAt: new Date(), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    if (!composed.ok) throw new Error(composed.detail);
    expect(composed.entry).toMatchObject({ currency: "USD", exchangeRate: 4000 });
    expect(composed.entry.roundingLine).toBeUndefined();
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountDoc, l.amountCompany, l.dimension ?? null])).toEqual([
      ["cash", "debit", 1500, 6000000, "payment_method:transfer"],
      ["fx_loss", "debit", 0, 100000, "fx_kind:realized"],
      ["receivable", "credit", 1000, 4100000, null],
      ["customer_advances", "credit", 500, 2000000, null],
    ]);
  });

  it("pesos against two USD invoices at two rates: each allocation's difference is its pesos received less its pesos at its own rate, the entry balances in pesos", () => {
    const payload = receivedPayload({
      ...base, amount: 8320000,
      allocations: [
        { invoiceId: invoiceA, invoiceNumber: "FE-1", currency: "USD", amount: 1000, amountReceipt: 4150000, amountCompany: 4100000, withholdings: [] },
        { invoiceId: invoiceB, invoiceNumber: "FE-2", currency: "USD", amount: 1000, amountReceipt: 4170000, amountCompany: 4200000, withholdings: [] },
      ],
    });
    expect(payload).toMatchObject({ currency: "COP", amount: 8320000, amountDoc: 8320000, applied: 8300000, appliedDoc: 8320000, advance: 0 });
    expect(payload.allocations.map((a) => a.fx)).toEqual([{ gain: 50000, loss: 0 }, { gain: 0, loss: 30000 }]);
    const composed = composeEntry(accountingReceived.template as RuleTemplate, { id: "e1", event: "payments.received", payload, createdAt: new Date(), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    if (!composed.ok) throw new Error(composed.detail);
    expect(composed.entry.roundingLine).toBeUndefined();
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountDoc, l.amountCompany])).toEqual([
      ["cash", "debit", 8320000, 8320000],
      ["fx_loss", "debit", 0, 30000],
      ["receivable", "credit", 8320000, 8300000],
      ["fx_gain", "credit", 0, 50000],
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

describe("the application rules (plan 2B.2 Task 36, R36-2): the ledger shape", () => {
  const customer = { partyId: "0192b4c0-0000-7000-8000-00000000c001", legalName: "Tiendas D1 S.A.S." };
  const applicationId = "0192b4c0-0000-7000-8000-00000000f036";
  const payload = {
    date: "2026-11-06", number: "AP-1", applicationId, paymentId: applicationId, customer, currency: "COP", exchangeRate: 1,
    total: 300000, totalDoc: 300000, drawn: 300000, drawnDoc: 300000,
    allocations: [{ invoiceId: "0192b4c0-0000-7000-8000-00000000a001", invoiceNumber: "FE-1", amount: 300000, amountCompany: 300000, fx: { gain: 0, loss: 0 } }],
    advances: [{ receiptId: "0192b4c0-0000-7000-8000-00000000f005", receiptNumber: "RC-1", amount: 300000, amountDoc: 300000 }],
  };

  it("Dr customer_advances / Cr receivable for the whole total, the customer as party, the application as source", () => {
    const template = accountingAdvanceApplied.template as RuleTemplate;
    expect(template.source).toEqual({ entity: "payments.advance_application", id: "$.applicationId" });
    const composed = composeEntry(template, { id: "e1", event: "payments.advance.applied", payload, createdAt: new Date(), chainId: "c1" }, { tolerance: 0, companyCurrency: "COP" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany])).toEqual([["customer_advances", "debit", 300000], ["receivable", "credit", 300000]]);
    expect(composed.entry.partyId ?? composed.entry.lines[0]!.partyId).toBe(customer.partyId);
  });

  it("in USD: Dr customer_advances at the advance's rate, the realized loss in pesos only, Cr receivable at the invoice's rate (plan 2B.2 Task 34.6)", () => {
    const usd = {
      ...payload, currency: "USD", exchangeRate: 4000, total: 4100000, totalDoc: 1000, drawn: 4000000, drawnDoc: 1000,
      allocations: [{ ...payload.allocations[0]!, amount: 1000, amountCompany: 4100000, fx: { gain: 0, loss: 100000 } }],
      advances: [{ ...payload.advances[0]!, amount: 4000000, amountDoc: 1000 }],
    };
    const composed = composeEntry(accountingAdvanceApplied.template as RuleTemplate, { id: "e2", event: "payments.advance.applied", payload: usd, createdAt: new Date(), chainId: "c2" }, { tolerance: 0, companyCurrency: "COP" });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    expect(composed.entry.lines.map((l) => [l.role, l.side, l.amountCompany, l.amountDoc])).toEqual([
      ["customer_advances", "debit", 4000000, 1000], ["fx_loss", "debit", 100000, 0], ["receivable", "credit", 4100000, 1000],
    ]);
  });

  it("the reversal rule finds the application's entry by its source", () => {
    expect((accountingAdvanceUnapplied.template as RuleTemplate).reverseOf).toEqual({ event: "payments.advance.applied", sourceId: "$.applicationId" });
    expect(accountingAdvanceUnapplied.event).toBe("payments.advance.unapplied");
  });
});

describe("payments masked views, migrations 0109, 0150 and 0152", () => {
  for (const entity of PAYMENTS_ENTITIES) {
    it(`payments.v_${entity.table} is the generated masked view of ${entity.id}`, () => {
      const source = FX_ENTITIES.includes(entity.id) ? fxMigration : ADVANCE_ENTITIES.includes(entity.id) ? advanceFxMigration : migration;
      expect(source).toContain(maskedViewSql(defineEntity(entity)));
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
