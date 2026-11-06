import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineProcess, kernelModule, loadModules, POSTING_CONSUMER, Registry, type ConsumerContext, type PostingProvider } from "@erp/kernel";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { inventory } from "@erp/module-inventory";
import { invoicing as invoicingModule } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { buildPreview, cardEffects, catalogueOf, message, postingEffects } from "../runtime/preview";

// The accounting lines of a confirmation card (design §5.1): the posting provider says what an event will do.

const provider = {
  effectsFor: async (_ctx: ConsumerContext, event: string) => (event === "invoicing.invoice.issued" ? ["Contabilidad: asiento en Ventas"] : []),
} as unknown as PostingProvider;
const issue = defineProcess({ id: "invoicing.invoice.issue", module: "invoicing", kind: "create", description: "Emitir una factura", input: z.object({ number: z.string() }), output: z.object({}), emits: ["invoicing.invoice.issued"], handler: async () => ({}) });
const noEmit = defineProcess({ id: "invoicing.invoice.note", module: "invoicing", kind: "update", description: "Anotar", input: z.object({}), output: z.object({}), handler: async () => ({}) });
const base = { version: "1", dependsOn: [], entities: [], features: [], navigation: [] };
const ledger = defineModule({ ...base, id: "ledger", processes: [], events: { emits: [], consumes: { "*": POSTING_CONSUMER } }, postingProvider: provider });
const invoicing = defineModule({ ...base, id: "invoicing", processes: [issue, noEmit], events: { emits: ["invoicing.invoice.issued"], consumes: {} } });
const registry = new Registry();
loadModules(registry, [ledger, invoicing]);
const ctx = {} as ConsumerContext;

describe("posting effects on the confirmation card", () => {
  it("the confirmation card of a process that emits invoicing.invoice.issued lists 'Contabilidad: asiento en Ventas'", async () => {
    const lines = await postingEffects(registry, issue, ctx);
    expect(lines).toEqual(["Contabilidad: asiento en Ventas"]);
    const preview = buildPreview(registry, issue, { number: "FE-1" }, { locale: "es-419", stepUp: false, postingEffects: lines });
    expect(preview.effects).toEqual(expect.arrayContaining([{ label: "Contabilidad", value: "asiento en Ventas" }]));
  });
  it("a process that emits nothing gets no accounting line", async () => {
    expect(await postingEffects(registry, noEmit, ctx)).toEqual([]);
  });
});

// The module effects of the sales chain (plan 2B Task 25): each module declares, in its manifest, what it does when an event happens
// (inventory reserves on sales.order.confirmed, costing values the delivery…) or what a run of one of its processes does beyond its
// events (Anular issues the annulment credit note); the card lists them, in the user's language, for the modules the company has, then
// the posting provider's lines.

const chainRegistry = new Registry();
const chainLedger = defineModule({
  ...base,
  id: "accounting",
  processes: [],
  events: { emits: [], consumes: { "*": POSTING_CONSUMER } },
  postingProvider: {
    effectsFor: async (_ctx: ConsumerContext, event: string) =>
      ({
        "invoicing.invoice.issued": ["Contabilidad: asiento en Ventas", "Contabilidad: asiento en Ventas"],
        "invoicing.note.issued": ["Contabilidad: asiento en Ventas"],
        "payments.received": ["Contabilidad: asiento en Recibos de caja"],
        "payments.payment.voided": ["Contabilidad: asiento en Recibos de caja"],
      })[event] ?? [],
  } as unknown as PostingProvider,
});
loadModules(chainRegistry, [kernelModule, core, inventory, costing, sales, crm, invoicingModule, payments, chainLedger]);
const all: (moduleId: string) => Promise<boolean> = async () => true;
const card = (id: string, locale = "es-419", isEntitled = all) => cardEffects(chainRegistry, chainRegistry.process(id), ctx, { locale, isEntitled });
const labels = (lines: string[]) => lines.map((l) => l.slice(0, l.indexOf(": ")));

describe("module effects on the confirmation card (2B)", () => {
  it("confirming an order: inventory reserves, invoicing may create the invoice, the CRM marks the deal won", async () => {
    const lines = await card("sales.order.confirm");
    expect(labels(lines)).toEqual(expect.arrayContaining(["Inventario", "Facturación", "CRM"]));
    expect(lines.find((l) => l.startsWith("Inventario"))).toMatch(/reserva/);
  });

  it("shipping a delivery: Inventario takes the stock out and Costo de ventas values it at the weighted average", async () => {
    const lines = await card("sales.delivery.ship");
    expect(labels(lines)).toEqual(expect.arrayContaining(["Inventario", "Costo de ventas"]));
    expect(lines.find((l) => l.startsWith("Costo de ventas"))).toMatch(/promedio/);
  });

  it("issuing an invoice: Facturación DIAN (numbering, CUFE, sending) and one 'Contabilidad: asiento en Ventas' (lines are not repeated)", async () => {
    const lines = await card("invoicing.invoice.issue");
    expect(labels(lines)).toContain("Facturación DIAN");
    expect(lines.filter((l) => l === "Contabilidad: asiento en Ventas")).toHaveLength(1);
    expect(lines.at(-1)).toBe("Contabilidad: asiento en Ventas");
  });

  it("invoicing what was delivered creates Borradores: Facturación says nothing goes to the DIAN before Emitir", async () => {
    const lines = await card("invoicing.invoice.from_orders");
    expect(lines.find((l) => l.startsWith("Facturación:"))).toMatch(/Borrador/);
    expect(labels(lines)).not.toContain("Facturación DIAN");
  });

  it("voiding an issued invoice: Nota crédito DIAN and the annulment's entry in Ventas", async () => {
    const lines = await card("invoicing.invoice.void");
    expect(labels(lines)).toEqual(expect.arrayContaining(["Nota crédito DIAN", "Contabilidad"]));
    expect(lines).toContain("Contabilidad: asiento en Ventas");
  });

  it("receiving a payment: the receipt's entry in Recibos de caja, the withholdings suffered, the invoices' balance", async () => {
    const lines = await card("payments.payment.receive");
    expect(lines).toContain("Contabilidad: asiento en Recibos de caja");
    expect(labels(lines)).toEqual(expect.arrayContaining(["Retenciones", "Facturación"]));
    expect(labels(await card("payments.payment.void"))).toEqual(expect.arrayContaining(["Pagos", "Facturación", "Contabilidad"]));
  });

  it("a stock adjustment is valued by costing; a voided delivery gives the stock back and reverses its cost of sales", async () => {
    expect(labels(await card("inventory.adjustment.post"))).toContain("Costos");
    expect(labels(await card("sales.delivery.void"))).toEqual(expect.arrayContaining(["Inventario", "Costo de ventas"]));
  });

  it("with the dry run's events: only what the run would emit, and the provider gets each payload (a rule's `when`)", async () => {
    const seen: unknown[] = [];
    const reg = new Registry();
    const ledger = defineModule({
      ...base, id: "accounting", processes: [], events: { emits: [], consumes: { "*": POSTING_CONSUMER } },
      postingProvider: { effectsFor: async (_c: ConsumerContext, event: string, payload?: unknown) => (seen.push([event, payload]), event === "invoicing.invoice.created" ? ["Contabilidad: nada"] : []) } as unknown as PostingProvider,
    });
    loadModules(reg, [kernelModule, core, inventory, costing, sales, crm, invoicingModule, payments, ledger]);
    // Confirming an order whose dry run emitted only sales.order.confirmed and an invoice's creation (auto-invoicing on confirmation).
    const events = [{ event: "sales.order.confirmed", payload: { orderId: "o" } }, { event: "invoicing.invoice.created", payload: { invoiceId: "i" } }];
    const lines = await cardEffects(reg, reg.process("sales.order.confirm"), ctx, { locale: "es-419", isEntitled: all, events });
    expect(labels(lines)).toEqual(expect.arrayContaining(["Inventario", "Facturación", "Contabilidad"]));
    expect(lines.find((l) => l.startsWith("Facturación") && /Borrador/.test(l))).toBeDefined();
    expect(seen).toEqual([["sales.order.confirmed", { orderId: "o" }], ["invoicing.invoice.created", { invoiceId: "i" }]]);
    // Without events (a step-up card) the declared ones, with no payload.
    seen.length = 0;
    await cardEffects(reg, reg.process("sales.order.confirm"), ctx, { locale: "es-419", isEntitled: all });
    expect(seen).toEqual([["sales.order.confirmed", undefined]]);
  });

  it("only the modules the company has: without inventory and costing the delivery's card lists neither", async () => {
    const lines = await card("sales.delivery.ship", "es-419", async (moduleId) => !["inventory", "costing"].includes(moduleId));
    expect(labels(lines)).not.toContain("Inventario");
    expect(labels(lines)).not.toContain("Costo de ventas");
  });

  it("reads in the user's language (en mirror)", async () => {
    const lines = await card("sales.delivery.ship", "en");
    expect(labels(lines)).toEqual(expect.arrayContaining(["Inventory", "Cost of sales"]));
  });

  it("every declared effect is a key of the module's own namespace, present in es-419 and en as 'Label: text'", () => {
    const declared = chainRegistry.modules().flatMap((m) => Object.values(m.effects ?? {}).flat().map((key) => ({ module: m.id, key })));
    expect(declared.length).toBeGreaterThanOrEqual(20);
    for (const { module, key } of declared) {
      expect(key.startsWith(`${module}.effects.`), key).toBe(true);
      for (const locale of ["es-419", "en"]) expect(message(catalogueOf(locale), key), `${locale} ${key}`).toMatch(/^[^:]+: \S/);
    }
  });
});
