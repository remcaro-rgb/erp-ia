import { fileStore, withClaims } from "@erp/kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { INVOICE_PRINT_LINE_COLUMNS, invoiceRecordTemplate } from "../pdf/invoice-template";
import { chainHarness, type ChainHarness } from "./chain-helpers";

// Lots on the invoice and in its electronic document (plan 2B.2 Task 28.4, PG §3.5; RG-5, owner items 149, 150; migrations 0166–0167):
//   (1) an invoice made from an entrega that left by FEFO in two lots carries them on its line (invoice_lines.lots, copied from sales'
//       published sales.v_invoice_delivery_lines.lots when the line is written, written again at «Emitir» and frozen there): editing the lot
//       or what sales recorded afterwards changes nothing on the issued invoice. The PDF's lines table prints «Lote / Vence / Serie».
//   (2) the electronic document: with invoicing.settings.dian_item_instance off (the default) the XML has no cac:ItemInstance (the golden of
//       today, pinned in the pack's own tests); on (step-up, like the other DIAN settings) every lot of the line is one cac:ItemInstance with
//       its LotNumberID and ExpiryDate. The CUFE is the one «Emitir» computed either way.

let h: ChainHarness;
let productId: string;
let lot: Record<string, string>;

interface InvoiceLine { id: string; lots: { lotCode: string | null; expiresOn: string | null; serialNo: string | null; qty: number }[] | null }

const linesOf = (invoiceId: string) => h.sql<InvoiceLine[]>`select id, lots from invoicing.invoice_lines where invoice_id = ${invoiceId} order by line_no`;

/** A confirmed pedido of `qty` units of the lot product, shipped whole (FEFO), and its invoice from «Por facturar» (a Borrador). */
async function invoicedDelivery(qty: number): Promise<{ invoiceId: string; deliveryLineId: string }> {
  const order = await h.run<{ id: string }>(h.admin, "sales.order.create", { partyId: h.partyId, issueDate: h.today, warehouseId: h.warehouseId, lines: [{ productId, qty, unitPrice: 20000 }] });
  await h.run(h.admin, "sales.order.confirm", { id: order.id });
  expect(await h.drain()).toEqual([]);
  const delivery = await h.run<{ id: string; lines: { id: string }[] }>(h.admin, "sales.delivery.create", { orderId: order.id, date: h.today, costCenterId: h.costCenterId });
  await h.run(h.admin, "sales.delivery.ship", { id: delivery.id });
  expect(await h.drain()).toEqual([]);
  const created = await h.run<{ invoices: { id: string }[] }>(h.admin, "invoicing.invoice.from_orders", { orderIds: [order.id] });
  return { invoiceId: created.invoices[0]!.id, deliveryLineId: delivery.lines[0]!.id };
}

const xmlOf = async (invoiceId: string) => {
  expect(await h.settleDian(invoiceId)).toBe("accepted");
  const [s] = await h.sql<{ xml_path: string; cufe: string }[]>`select xml_path, cufe from invoicing.einvoice_submissions where invoice_id = ${invoiceId} and note_id is null`;
  return { xml: new TextDecoder().decode(await (await fileStore()).get(s!.xml_path)), cufe: s!.cufe };
};

describe("lots on the invoice and in the DIAN document (Task 28.4)", () => {
  beforeAll(async () => {
    h = await chainHarness();
    productId = (await h.run<{ id: string }>(h.admin, "core.product.create", {
      sku: "CAF-MOL-LOT", description: "Café molido 500 g", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 24000, isFreeSample: false, trackStock: true,
    })).id;
    await h.runStepUp("inventory.product_tracking.set", { productId, tracking: "lot" });
    // Lot L-2311 expires first (3 units), L-2402 later (10): a delivery of 5 leaves 3 of L-2311 and 2 of L-2402.
    await h.run(h.admin, "inventory.movement.post", { kind: "receipt", date: `${h.year}-01-10`, warehouseId: h.warehouseId, lines: [
      { productId, locationId: h.locationId, qty: 10, unitCost: 14000, lot: { code: "L-2402", expiresOn: `${h.year + 1}-03-15` } },
      { productId, locationId: h.locationId, qty: 3, unitCost: 14000, lot: { code: "L-2311", expiresOn: `${h.year + 1}-01-20` } },
    ] });
    expect(await h.drain()).toEqual([]);
    lot = Object.fromEntries((await h.sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${productId}`).map((l) => [l.code, l.id]));
  }, 300_000);

  afterAll(async () => {
    await h.cleanup();
  });

  it("(1) the invoice line of a FEFO-split entrega carries both lots, frozen at «Emitir»; the PDF prints them", async () => {
    const { invoiceId, deliveryLineId } = await invoicedDelivery(5);
    const expected = [
      { lotCode: "L-2311", expiresOn: `${h.year + 1}-01-20`, serialNo: null, qty: 3 },
      { lotCode: "L-2402", expiresOn: `${h.year + 1}-03-15`, serialNo: null, qty: 2 },
    ];
    // Published by sales for invoicing (0166): the entrega line's lots as JSON.
    const [published] = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ lots: unknown }[]>`select lots from sales.v_invoice_delivery_lines where id = ${deliveryLineId}`);
    expect(published!.lots).toEqual(expected);
    // Copied onto the Borrador's line when it is written from the entrega line.
    expect((await linesOf(invoiceId))[0]!.lots).toEqual(expected);

    await h.run(h.admin, "invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    const [issued] = await linesOf(invoiceId);
    expect(issued!.lots).toEqual(expected);

    // Frozen: a later edit of the lot, or of what sales recorded of the entrega, changes nothing on the issued invoice.
    await h.run(h.admin, "inventory.lot.update", { id: lot["L-2311"]!, expiresOn: `${h.year + 1}-02-28` });
    await h.sql`update sales.delivery_line_lots set lot_code = 'CAMBIADO' where delivery_line_id = ${deliveryLineId}`;
    expect((await linesOf(invoiceId))[0]!.lots).toEqual(expected);
    await h.sql`update sales.delivery_line_lots x set lot_code = l.code from inventory.lots l where l.id = x.lot_id and x.delivery_line_id = ${deliveryLineId}`;

    // The masked view reads «Lote / Vence / Serie» as text; the invoice's lines table prints that column.
    const [view] = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ lots: string | null }[]>`select lots from invoicing.v_invoice_lines where id = ${issued!.id}`);
    expect(view!.lots).toBe(`L-2311 · ${h.year + 1}-01-20 · 3; L-2402 · ${h.year + 1}-03-15 · 2`);
    expect(INVOICE_PRINT_LINE_COLUMNS).toContain("lots");
    expect(JSON.stringify(invoiceRecordTemplate({ title: "Factura" }).blocks)).toContain("\"lots\"");

    // (2) Setting off (the default): no cac:ItemInstance in the document the workflow built and kept.
    const [settings] = await h.sql<{ dian_item_instance: boolean }[]>`select dian_item_instance from invoicing.settings where company_id = ${h.companyId}`;
    expect(settings!.dian_item_instance).toBe(false);
    const off = await xmlOf(invoiceId);
    expect(off.xml).not.toContain("ItemInstance");
    const [cufe] = await h.sql<{ cufe: string }[]>`select cufe from invoicing.invoices where id = ${invoiceId}`;
    expect(off.cufe).toBe(cufe!.cufe);
  });

  it("(2) the setting is step-up and admin-only; on, every lot of the line is one cac:ItemInstance with its lot and expiry", async () => {
    // The DIAN checklist (Task 35) lists lotes_en_xml only while the setting is on; then the confirmation needs it ticked.
    type Checklist = { version: number; items: { key: string; ticked: boolean }[] };
    const keys = async () => (await h.run<Checklist>(h.admin, "invoicing.dian_checklist.consult", {})).items.map((i) => i.key);
    const before = await h.run<Checklist>(h.admin, "invoicing.dian_checklist.consult", {});
    expect(before.items.map((i) => i.key)).not.toContain("lotes_en_xml");
    expect(await h.refusal(h.run(h.admin, "invoicing.settings.update", { dianItemInstance: true }))).toMatchObject({ code: "step_up_required" });
    const updated = await h.runStepUp<{ dianItemInstance: boolean }>("invoicing.settings.update", { dianItemInstance: true });
    expect(updated.dianItemInstance).toBe(true);
    const [visible] = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ dian_item_instance: boolean }[]>`select dian_item_instance from invoicing.v_settings where company_id = ${h.companyId}`);
    expect(visible!.dian_item_instance).toBe(true);
    const after = await h.run<Checklist>(h.admin, "invoicing.dian_checklist.consult", {});
    expect(after.items.find((i) => i.key === "lotes_en_xml")).toMatchObject({ ticked: false });
    // The list's version does not move (a company that never turns it on keeps its confirmation).
    expect(after.version).toBe(before.version);
    expect(after.items).toHaveLength(before.items.length + 1);

    const { invoiceId } = await invoicedDelivery(2);
    await h.run(h.admin, "invoicing.invoice.issue", { id: invoiceId });
    expect(await h.drain()).toEqual([]);
    const on = await xmlOf(invoiceId);
    // L-2311 is used up by test (1): this entrega left from L-2402 only.
    expect(on.xml.match(/<cac:ItemInstance>/g)).toHaveLength(1);
    expect(on.xml).toMatch(new RegExp(`<cac:LotIdentification>\\s*<cbc:LotNumberID>L-2402</cbc:LotNumberID>\\s*<cbc:ExpiryDate>${h.year + 1}-03-15</cbc:ExpiryDate>`));
    const [cufe] = await h.sql<{ cufe: string }[]>`select cufe from invoicing.invoices where id = ${invoiceId}`;
    expect(on.cufe).toBe(cufe!.cufe);
    await h.runStepUp("invoicing.settings.update", { dianItemInstance: false });
    expect(await keys()).not.toContain("lotes_en_xml");
  });

  it("an invoice line that bills no lot (an untracked product, a line typed by hand) has no lots (RG-2)", async () => {
    const draft = await h.run<{ id: string }>(h.admin, "invoicing.invoice.create", { partyId: h.partyId, lines: [{ productId: h.cafe, qty: 1 }] });
    expect((await linesOf(draft.id))[0]!.lots).toBeNull();
    const [view] = await withClaims(h.sql, h.admin.claims, (tx) => tx<{ lots: string | null }[]>`select lots from invoicing.v_invoice_lines where invoice_id = ${draft.id}`);
    expect(view!.lots).toBeNull();
  });
});
