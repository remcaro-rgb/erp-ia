import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineModule, defineProcess, loadModules, POSTING_CONSUMER, Registry, type ConsumerContext, type PostingProvider } from "@erp/kernel";
import { buildPreview, postingEffects } from "../runtime/preview";

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
