import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Tx } from "../../db/client";
import { defineModule } from "../../module/define";
import { loadModules } from "../../module/loader";
import { kernelModule } from "../../module/kernel-module";
import { defineProcess } from "../../process/define";
import { defineEntity, Registry } from "../../registry";
import { nextStatus, type RecordStatus } from "../../typed/lifecycle";
import { BORRADOR_STATUS, documentLinkTrail, LINK_KIND, LINKS_FROM_MAX, linkEnd, linksSyncInput, linksVoidInput, makeLinks, trailInput } from "..";

// The document links API (design §22.27, plan 2B Task 31): the inputs a process hands ctx.links, the trail consult's input, and the
// refusals makeLinks raises before any SQL (the definer functions of 0124 refuse again whatever reaches them).

const A = "0190a0f1-0000-7000-8000-000000000001";
const B = "0190a0f1-0000-7000-8000-000000000002";

describe("linkEnd, linksSyncInput, linksVoidInput", () => {
  it("takes an entity and a record id, nothing else", () => {
    expect(linkEnd.safeParse({ entity: "sales.order", id: A }).success).toBe(true);
    expect(linkEnd.safeParse({ entity: "sales.order", id: "x" }).success).toBe(false);
    expect(linkEnd.safeParse({ entity: "", id: A }).success).toBe(false);
    expect(linkEnd.safeParse({ entity: "x".repeat(101), id: A }).success).toBe(false);
    expect(linkEnd.safeParse({ entity: "sales.order", id: A, number: "P-1" }).success).toBe(false);
  });

  it("checks the kind pattern <a>_to_<b>", () => {
    for (const kind of ["quote_to_order", "order_to_delivery", "delivery_to_invoice", "order_to_invoice", "invoice_to_receipt"]) {
      expect(linksSyncInput.safeParse({ to: { entity: "sales.order", id: A }, kind, from: [] }).success, kind).toBe(true);
      expect(LINK_KIND.test(kind)).toBe(true);
    }
    for (const kind of ["quote-to-order", "QuoteToOrder", "quote_order", "quote_to_", "_to_order", "quote_to_order_line", "quote2_to_order", ""]) {
      expect(linksSyncInput.safeParse({ to: { entity: "sales.order", id: A }, kind, from: [] }).success, kind).toBe(false);
    }
  });

  it("caps the from list and refuses unknown keys", () => {
    const from = Array.from({ length: LINKS_FROM_MAX + 1 }, () => ({ entity: "crm.quote", id: A }));
    expect(linksSyncInput.safeParse({ to: { entity: "sales.order", id: B }, kind: "quote_to_order", from }).success).toBe(false);
    expect(linksSyncInput.safeParse({ to: { entity: "sales.order", id: B }, kind: "quote_to_order", from: from.slice(1) }).success).toBe(true);
    expect(linksSyncInput.safeParse({ to: { entity: "sales.order", id: B }, kind: "quote_to_order", from: [], chainId: A }).success).toBe(false);
  });

  it("void takes the document and an optional reason of at most 500 characters", () => {
    expect(linksVoidInput.safeParse({ entity: "sales.order", id: A }).success).toBe(true);
    expect(linksVoidInput.safeParse({ entity: "sales.order", id: A, reason: "Pedido cancelado" }).success).toBe(true);
    expect(linksVoidInput.safeParse({ entity: "sales.order", id: A, reason: "x".repeat(501) }).success).toBe(false);
    expect(linksVoidInput.safeParse({ entity: "sales.order", id: A, by: "x" }).success).toBe(false);
  });
});

describe("trailInput", () => {
  it("defaults to both directions, 6 levels and 100 documents", () => {
    expect(trailInput.parse({ entity: "sales.order", id: A })).toEqual({ entity: "sales.order", id: A, direction: "both", depth: 6, cap: 100 });
  });

  it("caps the depth at 12 and the documents at 500", () => {
    expect(trailInput.safeParse({ entity: "sales.order", id: A, depth: 12, cap: 500 }).success).toBe(true);
    expect(trailInput.safeParse({ entity: "sales.order", id: A, depth: 13 }).success).toBe(false);
    expect(trailInput.safeParse({ entity: "sales.order", id: A, cap: 501 }).success).toBe(false);
    expect(trailInput.safeParse({ entity: "sales.order", id: A, depth: 0 }).success).toBe(false);
    expect(trailInput.safeParse({ entity: "sales.order", id: A, direction: "sideways" }).success).toBe(false);
    expect(trailInput.safeParse({ entity: "sales.order", id: A, extra: 1 }).success).toBe(false);
  });

  it("is a registered consult of the kernel", () => {
    expect(documentLinkTrail).toMatchObject({ id: "kernel.document_link.trail", module: "kernel", kind: "consult" });
    const registry = new Registry();
    loadModules(registry, [kernelModule]);
    expect(registry.process("kernel.document_link.trail").kind).toBe("consult");
  });
});

describe("the Borrador the SQL removes links of", () => {
  it("is the only documento status the lifecycle deletes (D1), the literal 0124 tests", () => {
    const statuses: RecordStatus[] = ["draft", "saved", "pending", "rejected", "approved", "posted", "voided"];
    const deletable = statuses.filter((s) => nextStatus("documento", s, "delete", { requiresApproval: true, posts: true }) === "deleted"
      || nextStatus("documento", s, "delete", { requiresApproval: false, posts: false }) === "deleted");
    expect(deletable).toEqual([BORRADOR_STATUS]);
  });
});

describe("makeLinks refusals before SQL", () => {
  const doc = (id: string, module: string) =>
    defineEntity({ entityType: "documento", id, module, schema: module, table: id.split(".")[1]!, label: `entity.${id}`, displayField: "number", defaultSort: { field: "number", dir: "asc" }, fields: [{ name: "number", type: "text", label: `field.${id}.number` }] });
  const proc = (id: string, kind: "create" | "update" | "delete" | "consult") =>
    defineProcess({ id, module: "lunit", kind, recordAccess: "none", description: "proceso de prueba", input: z.object({}), output: z.object({}), handler: async () => ({}) });
  const registry = new Registry();
  loadModules(registry, [
    kernelModule,
    defineModule({ id: "lunit", version: "0.0.1", dependsOn: [], entities: [doc("lunit.order", "lunit")], processes: [proc("lunit.order.create", "create"), proc("lunit.order.save", "update"), proc("lunit.order.remove", "delete"), proc("lunit.order.peek", "consult")], features: [], events: { emits: [], consumes: {} }, navigation: [] }),
    defineModule({ id: "lother", version: "0.0.1", dependsOn: [], entities: [doc("lother.quote", "lother")], processes: [], features: [], events: { emits: [], consumes: {} }, navigation: [] }),
  ]);
  /** No SQL may be reached by these refusals. */
  const tx = new Proxy(() => undefined, { apply: () => { throw new Error("SQL reached"); }, get: () => { throw new Error("SQL reached"); } }) as unknown as Tx;
  const sync = { to: { entity: "lunit.order", id: A }, kind: "quote_to_order", from: [{ entity: "lother.quote", id: B }] };

  it("refuses a consult or a delete process (forbidden)", async () => {
    await expect(makeLinks(tx, registry, "lunit.order.peek").sync(sync)).rejects.toMatchObject({ code: "forbidden" });
    await expect(makeLinks(tx, registry, "lunit.order.remove").sync(sync)).rejects.toMatchObject({ code: "forbidden" });
    await expect(makeLinks(tx, registry, "lunit.order.peek").markVoided({ entity: "lunit.order", id: A })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses a to entity of another module (forbidden), also for a void", async () => {
    await expect(makeLinks(tx, registry, "lunit.order.save").sync({ ...sync, to: { entity: "lother.quote", id: A }, from: [] })).rejects.toMatchObject({ code: "forbidden" });
    await expect(makeLinks(tx, registry, "lunit.order.save").markVoided({ entity: "lother.quote", id: A })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an unregistered entity on either side, a bad kind and a link to itself (invalid_input)", async () => {
    const links = makeLinks(tx, registry, "lunit.order.create");
    await expect(links.sync({ ...sync, to: { entity: "lunit.nothing", id: A } })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(links.sync({ ...sync, from: [{ entity: "lother.nothing", id: B }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(links.sync({ ...sync, kind: "quote-order" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(links.sync({ ...sync, from: [{ entity: "lunit.order", id: A }] })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(links.markVoided({ entity: "lunit.nothing", id: A })).rejects.toMatchObject({ code: "invalid_input" });
  });
});
