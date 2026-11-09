import { randomUUID } from "node:crypto";
import { addRefLabels, recordHref, setExportsStore, withClaims, type ProcessError } from "@erp/kernel";
import { MemoryFileStore } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfText } from "../../../../kernel/src/templates/__tests__/pdf-text";
import { crm } from "../index";
import { crmHarness, good, type CrmHarness } from "./helpers";

// Cotizaciones (plan 2B Task 12): priced from the customer's price list (sales' resolveLinePrice: customer list → default list → list
// price), taxed by the Colombia pack (computeTaxes), gated on invoice_ready (rule 10, §5.17: reasons in the error), Pendiente de
// Aprobación when a line discount is above the company threshold, locked once accepted, and printed with the entity's default template.

/** A complete juridical customer (DIAN data of core's fixtures), gran contribuyente. */
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"],
  personType: "1",
  documentType: "31",
  documentNumber,
  legalName,
  taxResponsibilities: ["O-13"],
  taxScheme: "01",
  countryCode: "CO",
  departmentCode: "11",
  municipalityCode: "11001",
  addressLine: "Cra 1 # 2-3",
  invoiceEmail: "fe@cliente.example",
});

interface QuoteOut {
  id: string;
  number: string | null;
  status: string;
  stage: string;
  requiresApproval: boolean;
  subtotal: number;
  taxTotal: number;
  total: number;
}

describe("crm quotes", () => {
  let h: CrmHarness;
  const exportsStore = new MemoryFileStore();
  let partyId: string;
  let plainPartyId: string;
  let notReadyPartyId: string;
  let cafe: string;
  let filtro: string;
  let molino: string;
  let notReady: string;
  let customerList: string;
  let defaultList: string;
  let opportunityId: string;

  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const product = async (sku: string, overrides: Record<string, unknown> = {}) => (await h.run<{ id: string }>(h.admin, "core.product.create", { ...good(sku), ...overrides })).id;
  /** Makes a party invoice_ready the way a real one becomes so: DIAN data complete and its required files (RUT, Cámara de Comercio). */
  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await h.sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${h.companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${h.seed.tenantId}/${h.companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  /** A core price list with `prices` by product id (fixture: core has no price list process of its own yet). */
  const priceList = async (name: string, prices: Record<string, number>) => {
    const [list] = await h.sql<{ id: string }[]>`
      insert into core.price_lists (company_id, name, currency_code, status, requires_approval) values (${h.companyId}, ${name}, 'COP', 'saved', false) returning id`;
    for (const [productId, price] of Object.entries(prices)) {
      await h.sql`insert into core.price_list_items (company_id, price_list_id, product_id, price) values (${h.companyId}, ${list!.id}, ${productId}, ${price})`;
    }
    return list!.id;
  };
  const create = (input: Record<string, unknown>, caller = h.admin) => h.run<QuoteOut>(caller, "crm.quote.create", { partyId, issueDate: "2026-11-05", validUntil: "2026-12-05", ...input });
  const linesOf = (quoteId: string) =>
    h.sql<{ product_id: string; unit_price: string; price_list_id: string | null; discount_pct: string; discount: string; base: string; iva: string; total: string }[]>`
      select product_id, unit_price, price_list_id, discount_pct, discount, base, iva, total from crm.quote_lines where quote_id = ${quoteId} order by line_no`;

  beforeAll(async () => {
    h = await crmHarness();
    setExportsStore(exportsStore);
    partyId = (await h.run<{ id: string }>(h.admin, "core.party.create", customer("860002964", "Distribuidora Andina S.A.S."))).id;
    plainPartyId = (await h.run<{ id: string }>(h.admin, "core.party.create", customer("890903938", "Tiendas del Valle S.A.S."))).id;
    notReadyPartyId = (await h.run<{ id: string }>(h.admin, "core.party.create", { ...customer("800197268", "Sin Papeles S.A.S."), addressLine: undefined })).id;
    await markReady(partyId);
    await markReady(plainPartyId);
    cafe = await product("CAF-500");
    filtro = await product("FIL-01", { description: "Filtro de papel", listPrice: 12000, ivaRate: "19" });
    molino = await product("MOL-01", { description: "Molino manual", listPrice: 150000, ivaRate: "19" });
    // A product whose DIAN data is incomplete is not invoice_ready (core's trigger computes the flag from dian_status).
    notReady = await product("SIN-01", { description: "Producto incompleto" });
    await h.sql`update core.products set dian_status = 'missing: 1', dian_missing = '{"Código estándar"}' where id = ${notReady}`;
    customerList = await priceList("Mayoristas", { [cafe]: 25000 });
    defaultList = await priceList("General", { [cafe]: 27000, [filtro]: 11000 });
    await h.run(h.admin, "sales.settings.update", { defaultPriceListId: defaultList });
    await h.run(h.admin, "sales.customer_terms.set", { partyId, priceListId: customerList, discountPct: 0 });
    const pipeline = await h.run<{ id: string }>(h.admin, "crm.pipeline.create", { code: "COT", name: "Embudo", stages: [{ name: "Nuevo", probability: 10, kind: "open" }, { name: "Ganada", probability: 100, kind: "won" }, { name: "Perdida", probability: 0, kind: "lost" }] });
    opportunityId = (await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: "Café para Andina", partyId, pipelineId: pipeline.id })).id;
  });
  afterAll(async () => {
    setExportsStore(undefined);
    await h.cleanup();
  });

  it("fixtures: the customer and the products are invoice_ready, the incomplete ones are not", async () => {
    const parties = await h.sql`select id, invoice_ready from core.parties where id = any(${[partyId, plainPartyId, notReadyPartyId]}::uuid[])`;
    expect(Object.fromEntries(parties.map((p) => [p.id, p.invoice_ready]))).toEqual({ [partyId]: true, [plainPartyId]: true, [notReadyPartyId]: false });
    const products = await h.sql`select id, invoice_ready from core.products where id = any(${[cafe, filtro, molino, notReady]}::uuid[])`;
    expect(Object.fromEntries(products.map((p) => [p.id, p.invoice_ready]))).toEqual({ [cafe]: true, [filtro]: true, [molino]: true, [notReady]: false });
  });

  it("prices each line: the customer's price list beats the default list, which beats the product's list price", async () => {
    const quote = await create({ lines: [{ productId: cafe, qty: 2 }, { productId: filtro, qty: 3 }, { productId: molino, qty: 1 }] });
    expect(quote).toMatchObject({ status: "saved", stage: "open", requiresApproval: false });
    expect(quote.number).toMatch(/^COT-\d+$/);
    const lines = await linesOf(quote.id);
    expect(lines.map((l) => [l.product_id, Number(l.unit_price), l.price_list_id])).toEqual([
      [cafe, 25000, customerList],
      [filtro, 11000, defaultList],
      [molino, 150000, null],
    ]);
    // A customer without terms takes the default list, then the list price.
    const plain = await create({ partyId: plainPartyId, lines: [{ productId: cafe, qty: 1 }, { productId: molino, qty: 1 }] });
    expect((await linesOf(plain.id)).map((l) => Number(l.unit_price))).toEqual([27000, 150000]);
    // A price given by hand wins over every list.
    const manual = await create({ lines: [{ productId: cafe, qty: 1, unitPrice: 20000 }] });
    expect((await linesOf(manual.id)).map((l) => [Number(l.unit_price), l.price_list_id])).toEqual([[20000, null]]);
  });

  it("totals are computeTaxes of the Colombia pack over the lines (per-line rounding, IVA 5 and 19, discount off the base)", async () => {
    const quote = await create({ lines: [{ productId: cafe, qty: 3, discountPct: 2.5 }, { productId: filtro, qty: 7 }, { productId: molino, qty: 1, discountPct: 1 }] });
    const expected = co.taxes.computeTaxes({
      date: "2026-11-05",
      party: { responsibilities: ["O-13"], personType: "1" },
      lines: [
        { quantity: 3, unitPrice: 25000, discount: 1875, kind: "good", ivaRate: "5" },
        { quantity: 7, unitPrice: 11000, discount: 0, kind: "good", ivaRate: "19" },
        { quantity: 1, unitPrice: 150000, discount: 1500, kind: "good", ivaRate: "19" },
      ],
    });
    expect({ subtotal: quote.subtotal, taxTotal: quote.taxTotal, total: quote.total }).toEqual({ subtotal: expected.subtotal, taxTotal: expected.taxTotal, total: expected.total });
    const [row] = await h.sql`select subtotal, discount_total, tax_total, total, total_company, max_discount_pct from crm.quotes where id = ${quote.id}`;
    expect(Object.fromEntries(Object.entries(row!).map(([k, v]) => [k, Number(v)]))).toEqual({
      subtotal: expected.subtotal,
      discount_total: 3375,
      tax_total: expected.taxTotal,
      total: expected.total,
      total_company: expected.total,
      max_discount_pct: 2.5,
    });
    const lines = await linesOf(quote.id);
    expect(lines.map((l) => [Number(l.base), Number(l.iva), Number(l.total)])).toEqual(expected.lines.map((l) => [l.base, l.iva, l.payable]));
  });

  it("refuses a product or a customer that is not invoice_ready, with the reasons in the error, and writes nothing", async () => {
    const before = await h.sql`select count(*)::int as n from crm.quotes where company_id = ${h.companyId}`;
    const product = await refusal(create({ lines: [{ productId: cafe, qty: 1 }, { productId: notReady, qty: 1, unitPrice: 1000 }] }));
    expect(product).toMatchObject({ code: "invalid_input" });
    expect(product!.message).toContain("not_invoice_ready");
    const productDetails = (product!.details as string[]).join(" | ");
    expect(productDetails).toContain("Línea 2");
    expect(productDetails).toContain("SIN-01");
    expect(productDetails).toContain("no está listo para facturar");
    expect(productDetails).toContain("Código estándar");
    const party = await refusal(create({ partyId: notReadyPartyId, lines: [{ productId: cafe, qty: 1 }] }));
    expect(party).toMatchObject({ code: "invalid_input" });
    const partyDetails = (party!.details as string[]).join(" | ");
    expect(partyDetails).toContain("Sin Papeles S.A.S.");
    expect(partyDetails).toContain("no está listo para facturar");
    expect(partyDetails).toContain("Dirección");
    expect(partyDetails).toContain("RUT");
    const after = await h.sql`select count(*)::int as n from crm.quotes where company_id = ${h.companyId}`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("refuses a customer or a product that is complete but not usable (rule 10, §22.22): pending approval or inactive, with the reason", async () => {
    // Complete DIAN data and files, but waiting for approval: invoice_ready on the row, not usable on documents.
    const pendingParty = (await h.run<{ id: string }>(h.admin, "core.party.create", customer("811009788", "Pendiente Aprobación S.A.S."))).id;
    await markReady(pendingParty);
    await h.sql`update core.parties set requires_approval = true, status = 'pending' where id = ${pendingParty}`;
    const party = await refusal(create({ partyId: pendingParty, lines: [{ productId: cafe, qty: 1 }] }));
    expect(party).toMatchObject({ code: "invalid_input" });
    expect(party!.message).toContain("not_invoice_ready");
    expect((party!.details as string[]).join(" | ")).toContain("Pendiente Aprobación S.A.S. no está listo para facturar: está pendiente de aprobación");
    const pendingProduct = await product("PEN-01", { description: "Producto por aprobar" });
    await h.sql`update core.products set requires_approval = true, status = 'pending' where id = ${pendingProduct}`;
    const inactive = await product("INA-01", { description: "Producto inactivo" });
    await h.sql`update core.products set is_active = false where id = ${inactive}`;
    const products = await refusal(create({ lines: [{ productId: pendingProduct, qty: 1 }, { productId: inactive, qty: 1 }] }));
    const details = (products!.details as string[]).join(" | ");
    expect(details).toContain("Línea 1: el producto PEN-01 (Producto por aprobar) no está listo para facturar: está pendiente de aprobación");
    expect(details).toContain("Línea 2: el producto INA-01 (Producto inactivo) no está listo para facturar: está inactivo");
    // Approved, the same product is usable again.
    await h.sql`update core.products set status = 'approved' where id = ${pendingProduct}`;
    expect(await create({ lines: [{ productId: pendingProduct, qty: 1, unitPrice: 1000 }] })).toMatchObject({ status: "saved" });
  });

  it("a price given by hand keeps the customer's standing discount, which still counts against the approval threshold (a USD quote)", async () => {
    await h.run(h.admin, "sales.customer_terms.set", { partyId: plainPartyId, priceListId: null, discountPct: 12 });
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: 10 });
    // In USD no COP list nor the list price applies (price_not_found), so the price is given by hand; the discount is still the customer's.
    const usd = await create({ partyId: plainPartyId, currency: "USD", exchangeRate: 4000, lines: [{ productId: cafe, qty: 1, unitPrice: 7 }] });
    expect(usd).toMatchObject({ status: "pending", requiresApproval: true });
    expect((await linesOf(usd.id)).map((l) => [Number(l.unit_price), Number(l.discount_pct), Number(l.discount)])).toEqual([[7, 12, 0.84]]);
    // A discount given on the line still wins over the standing one.
    const own = await create({ partyId: plainPartyId, currency: "USD", exchangeRate: 4000, lines: [{ productId: cafe, qty: 1, unitPrice: 7, discountPct: 0 }] });
    expect(own).toMatchObject({ status: "saved", requiresApproval: false });
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: null });
    await h.run(h.admin, "sales.customer_terms.set", { partyId: plainPartyId, priceListId: null, discountPct: 0 });
  });

  it("a salesperson cannot approve their own discount; an approver sees the quotes that need approval and approves them", async () => {
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: 10 });
    const over = await create({ lines: [{ productId: cafe, qty: 1, discountPct: 15 }] }, h.vendedor);
    expect(over).toMatchObject({ status: "pending" });
    const own = await refusal(h.run(h.vendedor, "crm.quote.approve", { id: over.id }));
    expect(own).not.toBeNull();
    expect(own!.code).toBe("forbidden");
    // The approver does not own it and may not reassign oportunidades, yet sees it (and its lines) because it needs approval.
    expect(await h.run<{ id: string }>(h.aprobadora, "crm.quote.consult", { id: over.id })).toMatchObject({ id: over.id });
    expect(await h.run(h.aprobadora, "crm.quote.approve", { id: over.id })).toMatchObject({ status: "approved" });
    // Still visible once approved (it went through approval); a quote that never needed approval is not.
    expect(await h.run<{ id: string }>(h.aprobadora, "crm.quote.consult", { id: over.id })).toMatchObject({ id: over.id });
    const plain = await create({ lines: [{ productId: cafe, qty: 1 }] }, h.vendedor);
    expect(await refusal(h.run(h.aprobadora, "crm.quote.consult", { id: plain.id }))).toMatchObject({ code: "not_found" });
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: null });
  });

  it("a discount above the company threshold waits for approval: Pendiente de Aprobación, not sendable until approved", async () => {
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: 10 });
    const within = await create({ lines: [{ productId: cafe, qty: 1, discountPct: 10 }] });
    expect(within).toMatchObject({ status: "saved", requiresApproval: false });
    const over = await create({ lines: [{ productId: cafe, qty: 1, discountPct: 15 }] });
    expect(over).toMatchObject({ status: "pending", requiresApproval: true });
    const early = await refusal(h.run(h.admin, "crm.quote.send", { id: over.id }));
    expect(early).toMatchObject({ code: "invalid_state" });
    expect(early!.message).toContain("quote_pending_approval");
    expect(await h.run(h.admin, "crm.quote.approve", { id: over.id })).toMatchObject({ status: "approved" });
    expect(await h.run(h.admin, "crm.quote.send", { id: over.id })).toMatchObject({ stage: "sent" });
    // Lowering the discount of a rejected one takes it out of approval.
    const again = await create({ lines: [{ productId: cafe, qty: 1, discountPct: 20 }] });
    await h.run(h.admin, "crm.quote.reject", { id: again.id, reason: "Descuento muy alto" });
    const lowered = await h.run<QuoteOut>(h.admin, "crm.quote.update", { id: again.id, lines: [{ productId: cafe, qty: 1, discountPct: 5 }] });
    expect(lowered).toMatchObject({ status: "saved", requiresApproval: false });
    await h.run(h.admin, "crm.settings.update", { quoteApprovalDiscountPct: null });
  });

  it("accept emits crm.quote.accepted with the oportunidad and locks the lines and the amounts", async () => {
    const quote = await create({ opportunityId, lines: [{ productId: cafe, qty: 4 }] });
    // Open: the lines may change.
    await h.run(h.admin, "crm.quote.update", { id: quote.id, lines: [{ productId: cafe, qty: 5 }] });
    expect(await h.run(h.admin, "crm.quote.send", { id: quote.id })).toMatchObject({ stage: "sent" });
    expect(await h.run(h.admin, "crm.quote.accept", { id: quote.id })).toMatchObject({ stage: "accepted" });
    const [event] = await h.sql<{ payload: Record<string, unknown> }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'crm.quote.accepted' and payload->>'quoteId' = ${quote.id}`;
    expect(event!.payload).toMatchObject({ quoteId: quote.id, number: quote.number, partyId, opportunityId, currency: "COP" });
    expect(event!.payload.lines).toEqual([expect.objectContaining({ productId: cafe, qty: 5, unitPrice: 25000, priceListId: customerList })]);
    // Locked: the update process, a second acceptance, Grabar with data and a direct write all refuse.
    expect(await refusal(h.run(h.admin, "crm.quote.update", { id: quote.id, lines: [{ productId: cafe, qty: 9 }] }))).toMatchObject({ code: "invalid_state" });
    expect(await refusal(h.run(h.admin, "crm.quote.accept", { id: quote.id }))).toMatchObject({ code: "invalid_state" });
    expect(await refusal(h.run(h.admin, "crm.quote.save", { id: quote.id, data: { notes: "cambio" } }))).toMatchObject({ code: "invalid_state" });
    await expect(h.sql`update crm.quote_lines set qty = 9 where quote_id = ${quote.id}`).rejects.toThrow(/aceptada no cambian/);
    await expect(h.sql`update crm.quotes set total = 1 where id = ${quote.id}`).rejects.toThrow(/aceptada no cambia/);
    expect((await linesOf(quote.id)).map((l) => Number(l.total))).toEqual([131250]);
    // A quote without an oportunidad leaves `opportunityId` out of the payload (the contract of Task 11: optional, never null). It is
    // accepted straight from open, never sent (intended: the customer may accept on the spot).
    const loose = await create({ lines: [{ productId: cafe, qty: 1 }] });
    await h.run(h.admin, "crm.quote.accept", { id: loose.id });
    const [looseEvent] = await h.sql<{ payload: Record<string, unknown> }[]>`
      select payload from kernel.outbox where event = 'crm.quote.accepted' and payload->>'quoteId' = ${loose.id}`;
    expect(looseEvent!.payload).not.toHaveProperty("opportunityId");
  });

  it("the chain (Tasks 11–13): an accepted quote becomes a pedido at its accepted prices; confirming it marks the oportunidad won", async () => {
    const pipeline = await h.run<{ id: string }>(h.admin, "crm.pipeline.create", { code: "PED", name: "Embudo pedidos", stages: [{ name: "Nuevo", probability: 10, kind: "open" }, { name: "Ganada", probability: 100, kind: "won" }, { name: "Perdida", probability: 0, kind: "lost" }] });
    const deal = await h.run<{ id: string }>(h.admin, "crm.opportunity.create", { title: "Pedido de Andina", partyId, pipelineId: pipeline.id });
    const quote = await create({ opportunityId: deal.id, lines: [{ productId: cafe, qty: 2 }, { productId: filtro, qty: 1, discountPct: 3 }] });
    await h.run(h.admin, "crm.quote.accept", { id: quote.id });
    // The customer's list changes after the acceptance: the pedido keeps the accepted price.
    await h.sql`update core.price_list_items set price = 30000 where price_list_id = ${customerList} and product_id = ${cafe}`;
    const order = await h.run<{ id: string; number: string; total: number }>(h.admin, "sales.order.from_quote", { quoteId: quote.id });
    await h.sql`update core.price_list_items set price = 25000 where price_list_id = ${customerList} and product_id = ${cafe}`;
    const lines = await h.sql`select unit_price::float8 as unit_price, discount_pct::float8 as discount_pct from sales.order_lines where order_id = ${order.id} order by line_no`;
    expect(lines).toEqual([{ unit_price: 25000, discount_pct: 0 }, { unit_price: 11000, discount_pct: 3 }]);
    expect(order.total).toBe(quote.total);
    await h.run(h.admin, "sales.order.confirm", { id: order.id });
    const [confirmed] = await h.sql<{ payload: Record<string, unknown> }[]>`
      select payload from kernel.outbox where company_id = ${h.companyId} and event = 'sales.order.confirmed' and payload->>'orderId' = ${order.id}`;
    expect(confirmed!.payload).toMatchObject({ orderId: order.id, opportunityId: deal.id, quoteId: quote.id });
    await crm.events.consumes["sales.order.confirmed"]!(h.consumer(), confirmed!.payload);
    const [won] = await h.sql`select outcome from crm.opportunities where id = ${deal.id}`;
    expect(won).toMatchObject({ outcome: "won" });
  });

  it("the pedido names its cotización (Task 53.2): quote_id_label is the quote's number for a viewer who reads quotes, nothing for one who does not (rule 14)", async () => {
    const quote = await create({ lines: [{ productId: cafe, qty: 1 }] });
    await h.run(h.admin, "crm.quote.accept", { id: quote.id });
    const order = await h.run<{ id: string }>(h.admin, "sales.order.from_quote", { quoteId: quote.id });
    const orderEntity = h.registry.entity("sales.order");
    expect(orderEntity.fields.find((f) => f.name === "quote_id")?.ref).toEqual({ entity: "crm.quote", display: "number" });
    const labelled = async (viewer = h.admin) => {
      const rows: Record<string, unknown>[] = [{ id: order.id, quote_id: quote.id }];
      await withClaims(h.sql, viewer.claims, (tx) => addRefLabels(tx, h.registry, orderEntity, rows));
      return rows[0]!;
    };
    expect(await labelled()).toMatchObject({ quote_id: quote.id, quote_id_label: quote.number });
    expect(recordHref("crm.quote", quote.id)).toBe(`/r/crm.quote/${quote.id}`);
    // A salesperson consults quotes but reads only their own (crm's owner scope): the admin's cotización is neither named nor marked
    // found for them, the raw id only.
    const row = await labelled(h.vendedor);
    expect(row.quote_id).toBe(quote.id);
    expect(row).not.toHaveProperty("quote_id_label");
    expect(row).not.toHaveProperty("quote_id_found");
  });

  it("expire closes an open or sent quote; an expired or past-validity quote cannot be accepted", async () => {
    // Expire does not wait for valid_until (2026-12-05 here): the salesperson closes an offer the customer turned down.
    const quote = await create({ lines: [{ productId: cafe, qty: 1 }] });
    expect(await h.run(h.admin, "crm.quote.expire", { id: quote.id })).toMatchObject({ stage: "expired" });
    expect(await refusal(h.run(h.admin, "crm.quote.accept", { id: quote.id }))).toMatchObject({ code: "invalid_state" });
    const old = await create({ issueDate: "2026-01-02", validUntil: "2026-01-31", lines: [{ productId: cafe, qty: 1 }] });
    const late = await refusal(h.run(h.admin, "crm.quote.accept", { id: old.id }));
    expect(late).toMatchObject({ code: "invalid_state" });
    expect(late!.message).toContain("quote_expired");
  });

  it("a salesperson sees only their own quotes and lines", async () => {
    const mine = await create({ lines: [{ productId: cafe, qty: 1 }] }, h.vendedor);
    const theirs = await create({ lines: [{ productId: cafe, qty: 1 }] }, h.vendedora);
    const seen = await h.run<{ id: string }>(h.vendedor, "crm.quote.consult", { id: mine.id });
    expect(seen.id).toBe(mine.id);
    expect(await refusal(h.run(h.vendedor, "crm.quote.consult", { id: theirs.id }))).toMatchObject({ code: "not_found" });
  });

  it("Imprimir prints the quote with its seeded default template (crm ships it; no company template): header, number and lines", async () => {
    const quote = await create({ lines: [{ productId: molino, qty: 2 }] });
    const { fileId } = await h.run<{ fileId: string }>(h.admin, "kernel.doc_template.print", { entity: "crm.quote", recordId: quote.id, title: "Cotización" });
    const [job] = await h.sql<{ state: { templateId: string | null; templateVersion: number; scope: string }; storage_path: string }[]>`
      select state, storage_path from kernel.export_jobs where id = ${fileId}`;
    expect(job!.state).toMatchObject({ templateId: null, templateVersion: 0, scope: "record" });
    const text = pdfText(await exportsStore.get(job!.storage_path));
    expect(text).toContain("Cotización");
    expect(text).toContain(quote.number!);
    expect(text).toContain("Molino manual");
    // The cotización's own template (crm's printTemplates), not the one generated from every field: no technical columns.
    for (const technical of ["max_discount_pct", "total_company", "requires_approval", "price_list_id", "created_at"]) expect(text).not.toContain(technical);
  });
});
