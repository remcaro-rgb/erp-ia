import { randomUUID } from "node:crypto";
import { buildConsumerContext, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sales } from "../index";

// Pedidos de venta (plan 2B Task 13, design §8.1 steps 1–2, migration 0084): priced like a cotización (or with the accepted cotización's
// own prices), taxed by the Colombia pack, gated on invoice_ready (rule 10), Pendiente de Aprobación when the customer's credit limit or the
// company's discount threshold is crossed; confirm emits one sales.order.confirmed (a replay with the same key answers the first result) and
// inventory's consumer reserves the stock (origin event, never a call from sales); cancel emits sales.order.cancelled and the consumer
// releases it. Sales and inventory are loaded together, as a company that has both.

const registry = new Registry();
loadModules(registry, [kernelModule, core, inventory, sales]);
const PROCESS_IDS = ["core", "inventory", "sales"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);

const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, standardCost: 16200, trackStock: true, ...overrides,
});
/** A complete juridical customer (DIAN data of core's fixtures), gran contribuyente. */
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

interface OrderOut {
  id: string;
  number: string | null;
  status: string;
  stage: string;
  requiresApproval: boolean;
  creditExceeded: boolean;
  discountExceeded: boolean;
  subtotal: number;
  taxTotal: number;
  total: number;
  confirmedAt: string | null;
}

describe("sales orders", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let admin: Caller;
  let other: Caller;
  let companyId: string;
  let otherCompanyId: string;
  let partyId: string;
  let cafe: string;
  let filtro: string;
  let servicio: string;
  let notReady: string;
  let warehouseId: string;
  let locationId: string;
  let customerList: string;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const create = (input: Record<string, unknown>, caller = admin) => run<OrderOut>(caller, "sales.order.create", { partyId, issueDate: "2026-11-05", warehouseId, ...input });
  const events = (event: string, orderId: string) =>
    sql<{ payload: Record<string, unknown>; chain_id: string }[]>`select payload, chain_id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>'orderId' = ${orderId} order by created_at`;
  /** Delivers `event` of the order to inventory's consumer, as the outbox dispatch does (origin event, system user, the event's chain). */
  const deliver = async (event: string, orderId: string) => {
    const [row] = await events(event, orderId);
    expect(row, `${event} of ${orderId} in the outbox`).toBeDefined();
    const ctx = buildConsumerContext(sql, { id: randomUUID(), event, companyId, chainId: row!.chain_id, createdAt: new Date() }, registry);
    await inventory.events.consumes[event]!(ctx, row!.payload);
  };
  const stockOf = async (productId: string) => {
    const [row] = await sql<{ on_hand: string | null; reserved: string | null; available: string | null }[]>`
      select sum(on_hand) as on_hand, sum(reserved) as reserved, sum(available) as available from inventory.v_stock where product_id = ${productId} and warehouse_id = ${warehouseId}`;
    return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0), available: Number(row?.available ?? 0) };
  };
  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  /** A fresh invoice_ready customer with `creditLimit` (each credit test has its own, so no test depends on another's pedidos). */
  const limitedCustomer = async (creditLimit: number) => {
    const documentNumber = String(800000000 + Math.floor(Math.random() * 99999999));
    const { id } = await run<{ id: string }>(admin, "core.party.create", customer(documentNumber, `Cliente con cupo ${documentNumber} S.A.S.`));
    await markReady(id);
    await run(admin, "sales.customer_terms.set", { partyId: id, creditLimit });
    return id;
  };
  /** Holds the credit lock of `party` (as sales.credit_exposure takes it) in a transaction of its own until `release` is called. */
  const holdCreditLock = async (party: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => (locked = resolve));
    const done = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`sales.credit:${companyId}:${party}`}, 0))`;
      locked();
      await released;
    });
    await isLocked;
    return { release: async () => { release(); await done; } };
  };
  const settled = <T>(promise: Promise<T>) => {
    const state = { done: false };
    promise.then(() => (state.done = true), () => (state.done = true));
    return state;
  };
  /** Receives `qty` more of `productId` into the bodega, so a test does not depend on what earlier tests left reserved. */
  const receive = (productId: string, qty: number) =>
    run(admin, "inventory.movement.post", { kind: "receipt", date: "2026-11-01", warehouseId, lines: [{ productId, locationId, qty }] });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * A cotización of crm as crm.quote.accept leaves it, read by sales through crm's published views (fixture: the sales package does not load
   * crm, which depends on sales). Written with the triggers off (replica role, seq given) so it may name an oportunidad id that only the
   * event payload carries on; crm's own test of the chain runs the real processes.
   */
  let fixtureSeq = 900000 + Math.floor(Math.random() * 1000) * 100;
  const acceptedQuote = async (lines: { productId: string; qty: number; unitPrice: number; discountPct: number; priceListId: string | null }[], opportunityId: string | null = null, stage = "accepted") => {
    const number = `COT-${Math.floor(Math.random() * 1e6)}`;
    const quoteId = randomUUID();
    const lineIds = lines.map(() => randomUUID());
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`insert into crm.quotes (id, seq, company_id, number, party_id, opportunity_id, issue_date, valid_until, stage, accepted_at, currency, exchange_rate, status, requires_approval, posts)
        values (${quoteId}, ${fixtureSeq++}, ${companyId}, ${number}, ${partyId}, ${opportunityId}, '2026-11-01', '2026-12-01', ${stage}, ${stage === "accepted" ? new Date() : null}, 'COP', 1, 'saved', false, false)`;
      for (const [i, l] of lines.entries()) {
        await tx`insert into crm.quote_lines (id, seq, company_id, quote_id, line_no, product_id, qty, unit_price, price_list_id, discount_pct)
          values (${lineIds[i]!}, ${fixtureSeq++}, ${companyId}, ${quoteId}, ${i + 1}, ${l.productId}, ${l.qty}, ${l.unitPrice}, ${l.priceListId}, ${l.discountPct})`;
      }
    });
    return { id: quoteId, number, lineIds };
  };

  beforeAll(async () => {
    registerCountryPack(co);
    await syncModuleManifest(sql, core);
    await syncModuleManifest(sql, inventory);
    await syncModuleManifest(sql, sales);
    seed = await seedTenant(sql, { companies: 2, entitlements: ["module:core", "module:inventory", "module:sales"] });
    for (const company of seed.companies) {
      for (const id of PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
      }
    }
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    other = { claims: seed.claimsFor(seed.users.both, otherCompanyId) as JwtClaims, origin: "ui" };

    partyId = (await run<{ id: string }>(admin, "core.party.create", customer("860002964", "Distribuidora Andina S.A.S."))).id;
    await markReady(partyId);
    cafe = (await run<{ id: string }>(admin, "core.product.create", good("CAF-500"))).id;
    filtro = (await run<{ id: string }>(admin, "core.product.create", good("FIL-01", { description: "Filtro de papel", listPrice: 12000, ivaRate: "19" }))).id;
    servicio = (await run<{ id: string }>(admin, "core.product.create", good("SRV-01", { description: "Instalación", kind: "service", trackStock: false, listPrice: 50000, ivaRate: "19", uomCode: "94" }))).id;
    notReady = (await run<{ id: string }>(admin, "core.product.create", good("SIN-01", { description: "Producto incompleto" }))).id;
    await sql`update core.products set dian_status = 'missing: 1', dian_missing = '{"Código estándar"}' where id = ${notReady}`;

    const [list] = await sql<{ id: string }[]>`
      insert into core.price_lists (company_id, name, currency_code, status, requires_approval) values (${companyId}, 'Mayoristas', 'COP', 'saved', false) returning id`;
    customerList = list!.id;
    await sql`insert into core.price_list_items (company_id, price_list_id, product_id, price) values (${companyId}, ${customerList}, ${cafe}, 25000)`;
    await run(admin, "sales.customer_terms.set", { partyId, priceListId: customerList, discountPct: 0 });

    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
    locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
    await run(admin, "inventory.movement.post", { kind: "receipt", date: "2026-11-01", warehouseId, lines: [{ productId: cafe, locationId, qty: 10 }, { productId: filtro, locationId, qty: 100 }] });
  });

  afterAll(async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ["sales.order_lines", "sales.orders", "sales.document_numbers", "sales.customer_terms", "sales.settings", "crm.quote_lines", "crm.quotes"]) {
        await tx`delete from ${tx(table)} where company_id = any(${companyIds}::uuid[])`;
      }
      for (const table of ["reservations", "stock_levels", "movement_lines", "movements", "movement_numbers", "locations", "warehouses"]) {
        await tx`delete from ${tx(`inventory.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
      for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
        await tx`delete from ${tx(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
      }
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await seed.cleanup();
    await sql.end();
  });

  it("creates a pedido priced from the customer's list, numbered PED- on save, with the totals of the Colombia pack's computeTaxes", async () => {
    const order = await create({ lines: [{ productId: cafe, qty: 2 }, { productId: filtro, qty: 3, discountPct: 2.5 }] });
    expect(order).toMatchObject({ status: "saved", stage: "open", requiresApproval: false, creditExceeded: false, discountExceeded: false, confirmedAt: null });
    expect(order.number).toMatch(/^PED-\d+$/);
    const lines = await sql`select product_id, unit_price::float8 as unit_price, price_list_id from sales.order_lines where order_id = ${order.id} order by line_no`;
    expect(lines.map((l) => [l.product_id, l.unit_price, l.price_list_id])).toEqual([[cafe, 25000, customerList], [filtro, 12000, null]]);
    const expected = co.taxes.computeTaxes({
      date: "2026-11-05",
      party: { responsibilities: ["O-13"], personType: "1" },
      lines: [
        { quantity: 2, unitPrice: 25000, discount: 0, kind: "good", ivaRate: "5" },
        { quantity: 3, unitPrice: 12000, discount: 900, kind: "good", ivaRate: "19" },
      ],
    });
    expect({ subtotal: order.subtotal, taxTotal: order.taxTotal, total: order.total }).toEqual({ subtotal: expected.subtotal, taxTotal: expected.taxTotal, total: expected.total });
  });

  it("refuses a product that is not invoice_ready, with the reasons in the error (rule 10)", async () => {
    const error = await refusal(create({ lines: [{ productId: cafe, qty: 1 }, { productId: notReady, qty: 1 }] }));
    expect(error?.code).toBe("invalid_input");
    expect(error?.message).toMatch(/^not_invoice_ready/);
    expect(error?.details).toEqual([expect.stringMatching(/^Línea 2: el producto SIN-01 .*faltan datos DIAN: Código estándar/)]);
  });

  it("confirm emits exactly one sales.order.confirmed with the order, its lines, the customer and the dates", async () => {
    const order = await create({ deliveryDate: "2026-11-10", lines: [{ productId: cafe, qty: 1 }, { productId: servicio, qty: 1 }] });
    const confirmed = await run<OrderOut>(admin, "sales.order.confirm", { id: order.id });
    expect(confirmed).toMatchObject({ id: order.id, number: order.number, stage: "confirmed", status: "saved" });
    expect(confirmed.confirmedAt).toEqual(expect.any(String));
    const rows = await events("sales.order.confirmed", order.id);
    expect(rows).toHaveLength(1);
    const lineIds = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    expect(rows[0]!.payload).toMatchObject({
      orderId: order.id,
      number: order.number,
      warehouseId,
      customer: { partyId, name: "Distribuidora Andina S.A.S." },
      dates: { issueDate: "2026-11-05", deliveryDate: "2026-11-10", confirmedAt: confirmed.confirmedAt },
      currency: "COP",
      total: order.total,
      lines: [
        { lineId: lineIds[0]!.id, lineNo: 1, productId: cafe, qty: 1, unitPrice: 25000, warehouseId },
        { lineId: lineIds[1]!.id, lineNo: 2, productId: servicio, qty: 1, unitPrice: 50000, warehouseId },
      ],
    });
    // Without opportunity the key is absent, never null (Task 11's consumer ignores the event then).
    expect(rows[0]!.payload).not.toHaveProperty("opportunityId");
    // A confirmed pedido does not confirm again, and its lines no longer change.
    expect((await refusal(run(admin, "sales.order.confirm", { id: order.id })))?.message).toMatch(/^order_confirmed/);
    expect((await refusal(run(admin, "sales.order.update", { id: order.id, lines: [{ productId: cafe, qty: 5 }] })))?.message).toMatch(/^order_confirmed/);
    await expect(sql`update sales.order_lines set qty = 9 where order_id = ${order.id}`).rejects.toThrow(/confirmado/);
  });

  it("a replay of confirm with the same key answers the first result and emits nothing more", async () => {
    const order = await create({ lines: [{ productId: filtro, qty: 1 }] });
    const key = randomUUID();
    const first = await run<OrderOut>(admin, "sales.order.confirm", { id: order.id, idempotencyKey: key });
    const second = await run<OrderOut>(admin, "sales.order.confirm", { id: order.id, idempotencyKey: key });
    expect(second).toEqual(first);
    expect(await events("sales.order.confirmed", order.id)).toHaveLength(1);
    const [audit] = await sql<{ n: number }[]>`select count(distinct chain_id)::int as n from kernel.audit_log where company_id = ${companyId} and process_id = 'sales.order.confirm' and row_id = ${order.id}`;
    expect(audit!.n).toBe(1);
  });

  it("two confirms with the same key at once: the second answers the first's result, not a refusal", async () => {
    const order = await create({ lines: [{ productId: filtro, qty: 1 }] });
    const key = randomUUID();
    const [one, two] = await Promise.all([
      run<OrderOut>(admin, "sales.order.confirm", { id: order.id, idempotencyKey: key }),
      run<OrderOut>(admin, "sales.order.confirm", { id: order.id, idempotencyKey: key }),
    ]);
    expect(two).toEqual(one);
    expect(one).toMatchObject({ stage: "confirmed" });
    expect(await events("sales.order.confirmed", order.id)).toHaveLength(1);
  });

  it("a credit-limit breach sends the pedido to Pendiente de Aprobación; it confirms only once approved", async () => {
    const limited = await limitedCustomer(100000);
    // $ 80.000 + IVA 19 % = $ 95.200: within the $ 100.000 limit.
    const first = await create({ partyId: limited, lines: [{ productId: filtro, qty: 1, unitPrice: 80000 }] });
    expect(first).toMatchObject({ status: "saved", requiresApproval: false, creditExceeded: false });
    await run(admin, "sales.order.confirm", { id: first.id });
    // A second one of $ 23.800 takes the open pedidos to $ 119.000: over the limit.
    const second = await create({ partyId: limited, lines: [{ productId: filtro, qty: 2, unitPrice: 10000 }] });
    expect(second).toMatchObject({ status: "pending", stage: "open", requiresApproval: true, creditExceeded: true, discountExceeded: false });
    expect((await refusal(run(admin, "sales.order.confirm", { id: second.id })))?.message).toMatch(/^order_pending_approval/);
    expect(await events("sales.order.confirmed", second.id)).toHaveLength(0);
    await run(admin, "sales.order.approve", { id: second.id });
    const confirmed = await run<OrderOut>(admin, "sales.order.confirm", { id: second.id });
    expect(confirmed).toMatchObject({ status: "approved", stage: "confirmed" });
    expect(await events("sales.order.confirmed", second.id)).toHaveLength(1);
  });

  it("a pedido saved within the limit is sent to approval at confirm when other pedidos confirmed meanwhile took the customer over it", async () => {
    const limited = await limitedCustomer(100000);
    const big = await create({ partyId: limited, lines: [{ productId: filtro, qty: 1, unitPrice: 80000 }] });
    const small = await create({ partyId: limited, lines: [{ productId: filtro, qty: 2, unitPrice: 10000 }] });
    // Both were saved within the limit: neither counted the other, which was not confirmed yet.
    expect([big.status, small.status]).toEqual(["saved", "saved"]);
    await run(admin, "sales.order.confirm", { id: big.id });
    const routed = await run<OrderOut>(admin, "sales.order.confirm", { id: small.id });
    expect(routed).toMatchObject({ status: "pending", stage: "open", requiresApproval: true, creditExceeded: true, confirmedAt: null });
    expect(await events("sales.order.confirmed", small.id)).toHaveLength(0);
  });

  it("every confirm takes the customer's credit lock: an approved pedido and a saved one confirming at once cannot both pass", async () => {
    const limited = await limitedCustomer(100000);
    // A is over the limit on its own and approved (the override); B is within it alone.
    const a = await create({ partyId: limited, lines: [{ productId: filtro, qty: 1, unitPrice: 90000 }] });
    expect(a).toMatchObject({ status: "pending", creditExceeded: true });
    await run(admin, "sales.order.approve", { id: a.id });
    const b = await create({ partyId: limited, lines: [{ productId: filtro, qty: 1, unitPrice: 50000 }] });
    expect(b).toMatchObject({ status: "saved" });
    const lock = await holdCreditLock(limited);
    const confirmA = run<OrderOut>(admin, "sales.order.confirm", { id: a.id });
    const stateA = settled(confirmA);
    await sleep(400);
    // The approved pedido waits for the customer's credit lock too.
    expect(stateA.done).toBe(false);
    const confirmB = run<OrderOut>(admin, "sales.order.confirm", { id: b.id });
    await sleep(200);
    await lock.release();
    const [outA, outB] = await Promise.all([confirmA, confirmB]);
    expect(outA).toMatchObject({ stage: "confirmed", status: "approved" });
    expect(outB).toMatchObject({ stage: "open", status: "pending", creditExceeded: true });
  });

  it("a line discount above the company's threshold sends the pedido to approval", async () => {
    await run(admin, "sales.settings.update", { orderApprovalDiscountPct: 10 });
    const order = await create({ lines: [{ productId: filtro, qty: 1, discountPct: 15 }] });
    expect(order).toMatchObject({ status: "pending", requiresApproval: true, discountExceeded: true, creditExceeded: false });
    const within = await create({ lines: [{ productId: filtro, qty: 1, discountPct: 10 }] });
    expect(within).toMatchObject({ status: "saved", requiresApproval: false });
    await run(admin, "sales.settings.update", { orderApprovalDiscountPct: null });
  });

  it("inventory's consumer reserves the stock of a confirmed pedido (origin event); cancel releases it", async () => {
    const before = await stockOf(cafe);
    const order = await create({ lines: [{ productId: cafe, qty: 3 }, { productId: servicio, qty: 1 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    await deliver("sales.order.confirmed", order.id);
    expect(await stockOf(cafe)).toEqual({ onHand: before.onHand, reserved: before.reserved + 3, available: before.available - 3 });
    const [line] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} and line_no = 1`;
    const reservations = await sql`select status, qty::float8 as qty, audit.origin from inventory.reservations r
      left join lateral (select origin from kernel.audit_log a where a.row_id = r.id and a.process_id = 'inventory.reservation.create' limit 1) audit on true
      where r.source_entity = 'sales.order_line' and r.source_line_id = ${line!.id}`;
    expect(reservations).toEqual([{ status: "active", qty: 3, origin: "event" }]);
    // A redelivered event reserves nothing more.
    await deliver("sales.order.confirmed", order.id);
    expect((await stockOf(cafe)).reserved).toBe(before.reserved + 3);

    const cancelled = await run<OrderOut>(admin, "sales.order.cancel", { id: order.id, reason: "El cliente desistió" });
    expect(cancelled).toMatchObject({ stage: "cancelled", status: "voided" });
    const rows = await events("sales.order.cancelled", order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ orderId: order.id, reason: "El cliente desistió", lines: [{ lineId: line!.id, productId: cafe, qty: 3 }, { productId: servicio }] });
    await deliver("sales.order.cancelled", order.id);
    expect(await stockOf(cafe)).toEqual(before);
    expect((await refusal(run(admin, "sales.order.cancel", { id: order.id, reason: "otra vez" })))?.message).toMatch(/^order_cancelled/);
  });

  it("the reservations land on the confirm's causal chain", async () => {
    const order = await create({ lines: [{ productId: filtro, qty: 1 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    const [event] = await events("sales.order.confirmed", order.id);
    await deliver("sales.order.confirmed", order.id);
    const [line] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id}`;
    const chains = await sql<{ chain_id: string }[]>`select distinct a.chain_id from kernel.audit_log a join inventory.reservations r on r.id = a.row_id
      where r.source_line_id = ${line!.id} and a.process_id = 'inventory.reservation.create'`;
    const [confirmRun] = await sql<{ chain_id: string }[]>`select chain_id from kernel.audit_log where process_id = 'sales.order.confirm' and row_id = ${order.id} limit 1`;
    expect(chains.map((c) => c.chain_id)).toEqual([event!.chain_id]);
    expect(confirmRun!.chain_id).toBe(event!.chain_id);
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Fin de la prueba" });
    await deliver("sales.order.cancelled", order.id);
  });

  it("out of order: a cancellation consumed before its (retried) confirmation leaves nothing reserved, short lines included", async () => {
    const before = await stockOf(filtro);
    const order = await create({ lines: [{ productId: filtro, qty: 2 }, { productId: cafe, qty: 1000 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Desistió" });
    await deliver("sales.order.cancelled", order.id);
    await deliver("sales.order.confirmed", order.id);
    const lines = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    expect(await sql`select 1 from inventory.reservations where source_line_id = any(${lines.map((l) => l.id)}::uuid[]) and status = 'active'`).toHaveLength(0);
    expect(await stockOf(filtro)).toEqual(before);
  });

  it("a short line (nothing reserved) then cancelled, then the confirmation redelivered: still nothing reserved", async () => {
    await receive(cafe, 3);
    const available = (await stockOf(cafe)).available;
    const hog = await create({ lines: [{ productId: cafe, qty: available }] });
    await run(admin, "sales.order.confirm", { id: hog.id });
    await deliver("sales.order.confirmed", hog.id);
    const order = await create({ lines: [{ productId: cafe, qty: 2 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    await deliver("sales.order.confirmed", order.id);
    await run(admin, "sales.order.cancel", { id: hog.id, reason: "Libera" });
    await deliver("sales.order.cancelled", hog.id);
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Desistió" });
    await deliver("sales.order.cancelled", order.id);
    // Stock is available again, but the cancelled pedido's late confirmation reserves nothing.
    await deliver("sales.order.confirmed", order.id);
    const [line] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id}`;
    expect(await sql`select 1 from inventory.reservations where source_line_id = ${line!.id} and status = 'active'`).toHaveLength(0);
  });

  it("cancelling a pedido that was never confirmed emits nothing; the generic Anular of a confirmed one releases like Cancelar", async () => {
    const open = await create({ lines: [{ productId: filtro, qty: 1 }] });
    expect(await run<OrderOut>(admin, "sales.order.cancel", { id: open.id, reason: "No sigue" })).toMatchObject({ stage: "cancelled", status: "voided" });
    expect(await events("sales.order.cancelled", open.id)).toHaveLength(0);

    const before = await stockOf(filtro);
    const confirmed = await create({ lines: [{ productId: filtro, qty: 4 }] });
    await run(admin, "sales.order.confirm", { id: confirmed.id });
    await deliver("sales.order.confirmed", confirmed.id);
    expect((await stockOf(filtro)).reserved).toBe(before.reserved + 4);
    expect(await run<OrderOut>(admin, "sales.order.void", { id: confirmed.id, reason: "Anulado" })).toMatchObject({ stage: "cancelled", status: "voided" });
    expect(await events("sales.order.cancelled", confirmed.id)).toHaveLength(1);
    await deliver("sales.order.cancelled", confirmed.id);
    expect(await stockOf(filtro)).toEqual(before);
  });

  it("a pedido without bodega leaves warehouseId out of its event payloads, never null", async () => {
    const order = await create({ warehouseId: undefined, lines: [{ productId: filtro, qty: 1 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    const [confirmed] = await events("sales.order.confirmed", order.id);
    expect(confirmed!.payload).not.toHaveProperty("warehouseId");
    expect((confirmed!.payload.lines as Record<string, unknown>[])[0]).not.toHaveProperty("warehouseId");
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Fin" });
    const [cancelled] = await events("sales.order.cancelled", order.id);
    expect(cancelled!.payload).not.toHaveProperty("warehouseId");
  });

  it("customer_terms.set keeps the values left out", async () => {
    const party = await limitedCustomer(500000);
    await run(admin, "sales.customer_terms.set", { partyId: party, priceListId: customerList, discountPct: 4 });
    await run(admin, "sales.customer_terms.set", { partyId: party, notes: "Solo de contado" });
    const [terms] = await sql`select price_list_id, discount_pct::float8 as discount_pct, credit_limit::float8 as credit_limit, notes from sales.customer_terms where party_id = ${party}`;
    expect(terms).toEqual({ price_list_id: customerList, discount_pct: 4, credit_limit: 500000, notes: "Solo de contado" });
    await run(admin, "sales.customer_terms.set", { partyId: party, creditLimit: null });
    const [lifted] = await sql`select credit_limit, discount_pct::float8 as discount_pct from sales.customer_terms where party_id = ${party}`;
    expect(lifted).toEqual({ credit_limit: null, discount_pct: 4 });
  });

  it("a short-stock line reserves what is available and leaves the rest as backorder; the pedido still confirms", async () => {
    await receive(cafe, 3);
    const available = (await stockOf(cafe)).available;
    const order = await create({ lines: [{ productId: cafe, qty: available + 5 }] });
    await run(admin, "sales.order.confirm", { id: order.id });
    await deliver("sales.order.confirmed", order.id);
    expect((await stockOf(cafe)).available).toBe(0);
    const [line] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id}`;
    const [reservation] = await sql`select qty::float8 as qty from inventory.reservations where source_entity = 'sales.order_line' and source_line_id = ${line!.id} and status = 'active'`;
    expect(reservation).toEqual({ qty: available });
    // Nothing left: a second pedido confirms and reserves nothing.
    const next = await create({ lines: [{ productId: cafe, qty: 1 }] });
    await run(admin, "sales.order.confirm", { id: next.id });
    await deliver("sales.order.confirmed", next.id);
    const [nextLine] = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${next.id}`;
    expect(await sql`select 1 from inventory.reservations where source_line_id = ${nextLine!.id}`).toHaveLength(0);
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Prueba de faltante" });
    await deliver("sales.order.cancelled", order.id);
    await run(admin, "sales.order.cancel", { id: next.id, reason: "Prueba de faltante" });
    await deliver("sales.order.cancelled", next.id);
  });

  it("from_quote copies the accepted cotización's prices, not a live lookup, and carries the oportunidad to sales.order.confirmed", async () => {
    const opportunityId = randomUUID();
    const quote = await acceptedQuote([
      { productId: cafe, qty: 2, unitPrice: 25000, discountPct: 5, priceListId: customerList },
      { productId: filtro, qty: 4, unitPrice: 11500, discountPct: 0, priceListId: null },
    ], opportunityId);
    // After acceptance the customer's list and the product's list price change: the pedido keeps the cotización's prices.
    await sql`update core.price_list_items set price = 31000 where price_list_id = ${customerList} and product_id = ${cafe}`;
    await sql`update core.products set list_price = 99000 where id = ${filtro}`;
    const order = await run<OrderOut>(admin, "sales.order.from_quote", { quoteId: quote.id, warehouseId, issueDate: "2026-11-05" });
    expect(order).toMatchObject({ status: "saved", stage: "open" });
    const lines = await sql`select product_id, qty::float8 as qty, unit_price::float8 as unit_price, discount_pct::float8 as discount_pct, price_list_id, quote_line_id from sales.order_lines where order_id = ${order.id} order by line_no`;
    expect(lines).toEqual([
      { product_id: cafe, qty: 2, unit_price: 25000, discount_pct: 5, price_list_id: customerList, quote_line_id: quote.lineIds[0] },
      { product_id: filtro, qty: 4, unit_price: 11500, discount_pct: 0, price_list_id: null, quote_line_id: quote.lineIds[1] },
    ]);
    const [header] = await sql`select quote_id, opportunity_id, party_id from sales.orders where id = ${order.id}`;
    expect(header).toEqual({ quote_id: quote.id, opportunity_id: opportunityId, party_id: partyId });
    await sql`update core.price_list_items set price = 25000 where price_list_id = ${customerList} and product_id = ${cafe}`;
    await sql`update core.products set list_price = 12000 where id = ${filtro}`;

    // One pedido per cotización.
    expect((await refusal(run(admin, "sales.order.from_quote", { quoteId: quote.id, warehouseId })))?.message).toMatch(/^quote_already_ordered/);
    await run(admin, "sales.order.confirm", { id: order.id });
    const [confirmed] = await events("sales.order.confirmed", order.id);
    expect(confirmed!.payload).toMatchObject({ orderId: order.id, opportunityId, quoteId: quote.id });
    await deliver("sales.order.confirmed", order.id);
    await run(admin, "sales.order.cancel", { id: order.id, reason: "Fin de la prueba" });
    await deliver("sales.order.cancelled", order.id);
  });

  it("two conversions of the same cotización at once give one pedido; the other is refused as quote_already_ordered", async () => {
    const quote = await acceptedQuote([{ productId: filtro, qty: 1, unitPrice: 11000, discountPct: 0, priceListId: null }]);
    const results = await Promise.allSettled([
      run<OrderOut>(admin, "sales.order.from_quote", { quoteId: quote.id }),
      run<OrderOut>(admin, "sales.order.from_quote", { quoteId: quote.id }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as ProcessError).message).toMatch(/^quote_already_ordered/);
    expect(await sql`select 1 from sales.orders where quote_id = ${quote.id}`).toHaveLength(1);
  });

  it("from_quote refuses a cotización that is not accepted or not visible", async () => {
    const open = await acceptedQuote([{ productId: cafe, qty: 1, unitPrice: 25000, discountPct: 0, priceListId: null }], null, "open");
    expect((await refusal(run(admin, "sales.order.from_quote", { quoteId: open.id })))?.message).toMatch(/^quote_not_accepted/);
    expect((await refusal(run(admin, "sales.order.from_quote", { quoteId: randomUUID() })))?.code).toBe("not_found");
    const accepted = await acceptedQuote([{ productId: cafe, qty: 1, unitPrice: 25000, discountPct: 0, priceListId: null }]);
    expect((await refusal(run(other, "sales.order.from_quote", { quoteId: accepted.id })))?.code).toBe("not_found");
  });

  it("another company sees nothing of a pedido", async () => {
    const order = await create({ lines: [{ productId: filtro, qty: 1 }] });
    expect((await refusal(run(other, "sales.order.confirm", { id: order.id })))?.code).toBe("not_found");
    expect((await refusal(run(other, "sales.order.consult", { id: order.id })))?.code).toBe("not_found");
    const consulted = await run<{ number: string; stage: string }>(admin, "sales.order.consult", { id: order.id });
    expect(consulted).toMatchObject({ number: order.number, stage: "open" });
  });
});
