import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sales } from "../index";

// Void delivery offers re-reserving the stock (plan 2B.2 Task 43, design §8.1 steps 3–4, R43-1..R43-13, migrations 0133–0134): the whole
// chain with the real modules. sales.delivery.void { reReserve } asks inventory by a flag on sales.delivery.voided; inventory's consumer voids
// the sale issue and, nested in that run, reserves again (all or nothing, only when the stock suffices) and answers by event; sales records the
// outcome on the entrega (re_reserve_result, re_reserve_note). Every event is handed to its consumers as the dispatch workflow does (`drain`).

const registry = new Registry();
const MODULES = [kernelModule, core, accounting, inventory, costing, sales];
loadModules(registry, MODULES);
const PROCESS_IDS = ["core", "accounting", "inventory", "costing", "sales"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const LOADED = new Set(MODULES.map((m) => m.id));

const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, ...overrides,
});
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

interface DeliveryOut { id: string; number: string | null; status: string; stage: string; orderId: string; orderStage: string; lines: { id: string; orderLineId: string; productId: string; qty: number }[]; reReserve?: string }
interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
interface ReState { re_reserve_requested: boolean; re_reserve_result: string | null; re_reserve_note: string | null }

describe("void delivery: re-reserve the stock for the pedido", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let admin: Caller;
  let seller: Caller;
  let companyId: string;
  let otherCompanyId: string;
  let year: number;
  let costCenterId: string;
  let partyId: string;
  let warehouseId: string;
  let locationId: string;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${admin.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...admin, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const day = (month: number, d = 15) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const drain = async () => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    const failed = new Set<string>();
    for (let round = 0; round < 25; round++) {
      const rows = (await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and dispatched_at is null order by created_at, id`).filter((r) => !failed.has(r.id));
      if (rows.length === 0) return failures;
      for (const row of rows) {
        let ok = true;
        for (const consumer of consumers.for(row.event).filter((c) => LOADED.has(c.moduleId))) {
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            ok = false;
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (ok) await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id}`;
        else failed.add(row.id);
      }
    }
    throw new Error("drain did not settle");
  };
  const redeliver = async (row: OutboxRow, moduleId: string) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId)!;
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };
  const outbox = (event: string, key: string, value: string) =>
    sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>${key} = ${value} order by created_at`;

  const markReady = async (id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  /** A fresh stocked product received into the bodega (so every test counts its own stock). */
  const stocked = async (qty: number) => {
    const productId = (await run<{ id: string }>(admin, "core.product.create", good(`VR-${randomUUID().slice(0, 8)}`))).id;
    await run(admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [{ productId, locationId, qty, unitCost: 100 }] });
    expect(await drain()).toEqual([]);
    return productId;
  };
  const confirmedOrder = async (lines: { productId: string; qty: number }[]) => {
    const order = await run<{ id: string }>(admin, "sales.order.create", { partyId, issueDate: day(3, 1), warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run(admin, "sales.order.confirm", { id: order.id });
    expect(await drain()).toEqual([]);
    const ids = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, lineIds: ids.map((l) => l.id) };
  };
  const shippedDelivery = async (orderId: string, lines?: { orderLineId: string; qty: number }[]) => {
    const delivery = await run<DeliveryOut>(admin, "sales.delivery.create", { orderId, date: day(3, 10), costCenterId, ...(lines ? { lines } : {}) });
    await run(admin, "sales.delivery.ship", { id: delivery.id });
    expect(await drain()).toEqual([]);
    return delivery;
  };
  const voidDelivery = (id: string, extra: Record<string, unknown> = {}, caller = admin) => run<DeliveryOut>(caller, "sales.delivery.void", { id, reason: "Error de despacho", ...extra });
  const reState = async (id: string) => (await sql<ReState[]>`select re_reserve_requested, re_reserve_result, re_reserve_note from sales.deliveries where id = ${id}`)[0]!;
  const reserved = async (orderLineId: string) =>
    Number((await sql<{ n: string }[]>`select coalesce(sum(qty - released_qty), 0)::text as n from inventory.reservations where company_id = ${companyId} and source_line_id = ${orderLineId} and status = 'active'`)[0]!.n);
  const stock = async (productId: string) => {
    const [row] = await sql<{ on_hand: string | null; reserved: string | null }[]>`
      select sum(on_hand) as on_hand, sum(reserved) as reserved from inventory.v_stock where product_id = ${productId} and warehouse_id = ${warehouseId}`;
    return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0) };
  };

  beforeAll(async () => {
    registerCountryPack(co);
    for (const m of [core, inventory, costing, sales, accounting]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [{ name: "vendedor", companies: [0], role: "member" }],
      entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales"],
    });
    for (const company of seed.companies) {
      for (const id of PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
      }
    }
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    // A seller who may deliver and void entregas but holds no inventory right (cannot reserve stock).
    const [role] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'vendedor', false) returning id`;
    await seed.holdRoles(seed.users.vendedor!, companyId, [role!.id]);
    for (const id of PROCESS_IDS.filter((p) => p.startsWith("sales.") || p.startsWith("core.") && p.endsWith(".consult"))) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${role!.id}, ${id}) on conflict do nothing`;
    }
    seller = { claims: { ...seed.claimsFor(seed.users.vendedor!, companyId), role_ids: [role!.id] } as JwtClaims, origin: "ui" };

    await runStepUp("accounting.chart.seed", {});
    year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
    await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
    costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;
    partyId = (await run<{ id: string }>(admin, "core.party.create", customer("860002964", "Distribuidora Andina S.A.S."))).id;
    await markReady(partyId);
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
    locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
  }, 240_000);

  afterAll(async () => {
    const companyIds = [companyId, otherCompanyId];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.process_idempotency where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
    await sql`delete from kernel.outbox_dead_letter where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  });

  it("yes + enough stock: the pedido line is reserved again by what was delivered, the entrega records «reserved», one nested audit row on the void's chain, the pedido steps back", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 6 }]);
    expect(await reserved(order.lineIds[0]!)).toBe(6);
    const delivery = await shippedDelivery(order.id, [{ orderLineId: order.lineIds[0]!, qty: 4 }]);
    expect(await reserved(order.lineIds[0]!)).toBe(2);
    const voided = await voidDelivery(delivery.id, { reReserve: true });
    expect(voided).toMatchObject({ status: "voided", orderStage: "confirmed" });
    // The answer to the click: asked, inventory confirms by event.
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: null, re_reserve_note: expect.stringMatching(/Inventario confirma en unos segundos/) });
    const [voidedEvent] = await outbox("sales.delivery.voided", "deliveryId", delivery.id);
    expect(voidedEvent!.payload).toMatchObject({ reReserve: true, orderId: order.id });
    expect(await drain()).toEqual([]);
    expect(await reserved(order.lineIds[0]!)).toBe(6);
    expect(await stock(cafe)).toEqual({ onHand: 10, reserved: 6 });
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "reserved", re_reserve_note: expect.stringMatching(/reservaron de nuevo/) });
    const [audit] = await sql<{ origin: string }[]>`
      select origin from kernel.audit_log where company_id = ${companyId} and process_id = 'inventory.reservation.reserve_again' and chain_id = ${voidedEvent!.chain_id} limit 1`;
    expect(audit).toMatchObject({ origin: "event" });
    // A later entrega delivers from that reservation again, as before the void.
    const again = await shippedDelivery(order.id);
    expect(again.orderStage).toBeDefined();
    expect(await reserved(order.lineIds[0]!)).toBe(0);
  });

  it("owner item 119(c): the re-reservation is capped at what the pedido line released at ship, not at what the entrega shipped (partial reservation, no reservation)", async () => {
    const cafe = await stocked(10);
    // A rival pedido holds 8: the pedido reserves only the 2 left (a short line, backorder), and a third one finds nothing to reserve.
    const rival = await confirmedOrder([{ productId: cafe, qty: 8 }]);
    const partial = await confirmedOrder([{ productId: cafe, qty: 5 }]);
    const bare = await confirmedOrder([{ productId: cafe, qty: 3 }]);
    expect(await reserved(partial.lineIds[0]!)).toBe(2);
    expect(await reserved(bare.lineIds[0]!)).toBe(0);
    await run(admin, "sales.order.cancel", { id: rival.id, reason: "Cliente desiste" });
    expect(await drain()).toEqual([]);
    const shippedPartial = await shippedDelivery(partial.id);
    const shippedBare = await shippedDelivery(bare.id);
    expect(await reserved(partial.lineIds[0]!)).toBe(0);
    // Void both with «Reservar de nuevo»: the line that had reserved 2 gets 2 back (not the 5 shipped), the one that had nothing gets nothing.
    await voidDelivery(shippedPartial.id, { reReserve: true });
    await voidDelivery(shippedBare.id, { reReserve: true });
    expect(await drain()).toEqual([]);
    expect(await reserved(partial.lineIds[0]!)).toBe(2);
    expect(await reserved(bare.lineIds[0]!)).toBe(0);
    expect(await stock(cafe)).toEqual({ onHand: 10, reserved: 2 });
    expect(await reState(shippedPartial.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "reserved" });
    expect(await reState(shippedBare.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "none" });
    // Shipped and voided again, the cap holds: what is back is what was released, never more.
    const second = await shippedDelivery(partial.id, [{ orderLineId: partial.lineIds[0]!, qty: 4 }]);
    await voidDelivery(second.id, { reReserve: true });
    expect(await drain()).toEqual([]);
    expect(await reserved(partial.lineIds[0]!)).toBe(2);
  });

  it("yes + one product short: the void stands, nothing is reserved, the entrega records «insufficient» naming the product", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await shippedDelivery(order.id);
    // Another pedido takes what was left, and a movement then takes part of it away: after the return, the stock cannot cover this pedido again.
    const rival = await confirmedOrder([{ productId: cafe, qty: 6 }]);
    expect(await reserved(rival.lineIds[0]!)).toBe(6);
    await run(admin, "inventory.movement.post", { kind: "issue", date: day(3, 12), warehouseId, lines: [{ productId: cafe, locationId, qty: -3 }] });
    await voidDelivery(delivery.id, { reReserve: true });
    expect(await drain()).toEqual([]);
    expect(await reserved(order.lineIds[0]!)).toBe(0);
    expect(await reserved(rival.lineIds[0]!)).toBe(6);
    const state = await reState(delivery.id);
    expect(state).toMatchObject({ re_reserve_requested: true, re_reserve_result: "insufficient" });
    expect(state.re_reserve_note).toMatch(/no alcanzan/);
    expect(state.re_reserve_note).toMatch(/VR-/);
    // The stock did come back: 10 − 4 shipped − 3 issued + 4 returned.
    expect(await stock(cafe)).toMatchObject({ onHand: 7 });
  });

  it("no: exactly today's behaviour; absent leaves the result empty, false records «none»", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const first = await shippedDelivery(order.id);
    await voidDelivery(first.id);
    expect(await drain()).toEqual([]);
    expect(await reState(first.id)).toEqual({ re_reserve_requested: false, re_reserve_result: null, re_reserve_note: null });
    expect(await reserved(order.lineIds[0]!)).toBe(0);
    expect(await outbox("inventory.delivery_reservation.restored", "deliveryId", first.id)).toEqual([]);
    const second = await shippedDelivery(order.id);
    await voidDelivery(second.id, { reReserve: false });
    expect(await drain()).toEqual([]);
    expect(await reState(second.id)).toMatchObject({ re_reserve_requested: false, re_reserve_result: "none" });
    expect(await reserved(order.lineIds[0]!)).toBe(0);
    expect((await outbox("sales.delivery.voided", "deliveryId", second.id))[0]!.payload.reReserve).toBeUndefined();
  });

  it("an entrega never shipped, or a cancelled pedido: no flag on the event, nothing reserved, «none»", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const open = await run<DeliveryOut>(admin, "sales.delivery.create", { orderId: order.id, date: day(3, 10), costCenterId });
    await voidDelivery(open.id, { reReserve: true });
    expect(await reState(open.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "none" });
    expect(await outbox("sales.delivery.voided", "deliveryId", open.id)).toEqual([]);

    // A hand-made call on a cancelled pedido (a pedido with a living entrega cannot be cancelled by the processes): the pedido is closed by hand.
    const shipped = await shippedDelivery(order.id);
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      await tx`update sales.orders set stage = 'cancelled', cancelled_at = now() where id = ${order.id}`;
    });
    await voidDelivery(shipped.id, { reReserve: true });
    expect(await drain()).toEqual([]);
    expect(await reState(shipped.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "none", re_reserve_note: expect.stringMatching(/cancelado/) });
    expect((await outbox("sales.delivery.voided", "deliveryId", shipped.id))[0]!.payload.reReserve).toBeUndefined();
    expect(await reserved(order.lineIds[0]!)).toBe(0);
  });

  it("a user who can void but not reserve: the void goes through, nothing is reserved, «not_permitted»", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await shippedDelivery(order.id);
    expect(await voidDelivery(delivery.id, { reReserve: true }, seller)).toMatchObject({ status: "voided" });
    expect(await drain()).toEqual([]);
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "not_permitted" });
    expect(await reserved(order.lineIds[0]!)).toBe(0);
    expect(await stock(cafe)).toEqual({ onHand: 10, reserved: 0 });
  });

  it("a double void is refused as before; redelivered events reserve once and record once", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await shippedDelivery(order.id);
    await voidDelivery(delivery.id, { reReserve: true });
    expect((await refusal(voidDelivery(delivery.id, { reReserve: true })))?.message).toMatch(/^delivery_voided/);
    expect(await drain()).toEqual([]);
    const [voidedRow] = await outbox("sales.delivery.voided", "deliveryId", delivery.id);
    await redeliver(voidedRow!, "inventory");
    const [restoredRow] = await outbox("inventory.delivery_reservation.restored", "deliveryId", delivery.id);
    await redeliver(restoredRow!, "sales");
    expect(await reserved(order.lineIds[0]!)).toBe(4);
    expect(await outbox("inventory.delivery_reservation.restored", "deliveryId", delivery.id)).toHaveLength(1);
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_result: "reserved" });
  });

  it("an admin cannot set the pair void_issue → reserve_again to «continue and queue» (it moves stock reservations: Task 32 policy)", async () => {
    const refused = await refusal(runStepUp("kernel.admin.nested_run.pair.set", { parent: "inventory.sale.void_issue", nested: "inventory.reservation.reserve_again", totpCovers: false, onFailure: "continue" }));
    expect(refused).toMatchObject({ code: "invalid_input" });
    expect(String(refused?.message)).toMatch(/reserve_again|effects|stock/i);
    // Rolling back is the default and is accepted (it is also what no row means).
    await expect(runStepUp("kernel.admin.nested_run.pair.set", { parent: "inventory.sale.void_issue", nested: "inventory.reservation.reserve_again", totpCovers: false, onFailure: "rollback" })).resolves.toBeDefined();
  });
  // Fix round 1 (review M-3, M-2, M-1).
  it("M-3: the void's answer carries the decision (asked, not_permitted, none), so the screen never promises what the server ruled out", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const first = await shippedDelivery(order.id);
    expect(await voidDelivery(first.id, { reReserve: true }, seller)).toMatchObject({ reReserve: "not_permitted" });
    const second = await shippedDelivery(order.id);
    expect(await voidDelivery(second.id, { reReserve: true })).toMatchObject({ reReserve: "asked" });
    const third = await shippedDelivery(order.id);
    expect(await voidDelivery(third.id, { reReserve: false })).toMatchObject({ reReserve: "none" });
    const fourth = await shippedDelivery(order.id);
    expect((await voidDelivery(fourth.id)).reReserve).toBeUndefined();
    expect(await drain()).toEqual([]);
  });

  it("M-2: record_re_reservation is keyed on the result event: the key is stored and a redelivery answers the first run", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await shippedDelivery(order.id);
    await voidDelivery(delivery.id, { reReserve: true });
    expect(await drain()).toEqual([]);
    const [restoredRow] = await outbox("inventory.delivery_reservation.restored", "deliveryId", delivery.id);
    const keys = await sql<{ key: string }[]>`select key from kernel.process_idempotency where company_id = ${companyId} and process_id = 'sales.delivery.record_re_reservation' and key = ${`re_reserve:${restoredRow!.id}`}`;
    expect(keys).toHaveLength(1);
    await redeliver(restoredRow!, "sales");
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_result: "reserved" });
  });

  it("M-1: with the inventory module off for the company the entrega resolves to «none» at once (no endless «Inventario confirma…»)", async () => {
    const cafe = await stocked(10);
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await shippedDelivery(order.id);
    const [had] = await sql<{ enabled: boolean }[]>`select enabled from kernel.company_modules where company_id = ${companyId} and module_id = 'inventory'`;
    await sql`insert into kernel.company_modules (company_id, module_id, enabled) values (${companyId}, 'inventory', false) on conflict (company_id, module_id) do update set enabled = false`;
    try {
      await voidDelivery(delivery.id, { reReserve: true });
    } finally {
      if (had) await sql`update kernel.company_modules set enabled = ${had.enabled} where company_id = ${companyId} and module_id = 'inventory'`;
      else await sql`delete from kernel.company_modules where company_id = ${companyId} and module_id = 'inventory'`;
    }
    expect(await reState(delivery.id)).toMatchObject({ re_reserve_requested: true, re_reserve_result: "none" });
    expect((await outbox("sales.delivery.voided", "deliveryId", delivery.id))[0]!.payload.reReserve).toBeUndefined();
  });
});
