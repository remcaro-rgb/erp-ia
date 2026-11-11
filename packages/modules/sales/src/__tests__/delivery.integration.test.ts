import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, enqueueEvent, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sales } from "../index";

// Entregas and devoluciones (plan 2B Task 14, design §8.1 steps 3–4, OD-3, OD-4, migrations 0085–0086): the whole chain with the real
// modules and the real posting engine on the demo chart. sales.delivery.ship emits sales.delivery.shipped; inventory's consumer issues the
// stock (sale_issue, idempotency key = the entrega line) and uses up the pedido line's reservation; costing values the issue at the
// weighted average and emits costing.cogs.posted; the accounting engine posts Dr 613595 (with the cost center) / Cr 143505. Every event is
// handed to its consumers as the dispatch workflow does (`drain`: origin event, the row's chain, one delivery per module).

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

interface DeliveryOut { id: string; number: string | null; status: string; stage: string; orderId: string; orderStage: string; lines: { id: string; lineNo: number; orderLineId: string; productId: string; qty: number }[] }
interface ReturnOut { id: string; number: string | null; status: string; stage: string; lines: { id: string; deliveryLineId: string; qty: number }[] }
interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }

describe("sales deliveries and returns", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let admin: Caller;
  let companyId: string;
  let otherCompanyId: string;
  let year: number;
  let costCenterId: string;
  let partyId: string;
  let cafe: string;
  let servicio: string;
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

  /**
   * Hands every undispatched outbox row of the company to each consumer of its event (registration order, one delivery per module recorded
   * in kernel.outbox_deliveries), as the dispatch workflow does, until nothing new is emitted. Returns the consumer failures (the row stays
   * undispatched and is not retried by this drain).
   */
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
  /** Hands one outbox row to one module's consumer again (a redelivery). */
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
  const product = async (sku: string, overrides: Record<string, unknown> = {}) => (await run<{ id: string }>(admin, "core.product.create", good(sku, overrides))).id;
  const receive = async (productId: string, qty: number, unitCost: number, on = day(1, 10)) => {
    await run(admin, "inventory.movement.post", { kind: "receipt", date: on, warehouseId, lines: [{ productId, locationId, qty, unitCost }] });
    expect(await drain()).toEqual([]);
  };
  /** A confirmed pedido of `lines`, dated `issueDate`, its reservations consumed. */
  const confirmedOrder = async (lines: { productId: string; qty: number }[], issueDate = day(3, 1)) => {
    const order = await run<{ id: string; number: string }>(admin, "sales.order.create", { partyId, issueDate, warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run(admin, "sales.order.confirm", { id: order.id });
    expect(await drain()).toEqual([]);
    const ids = await sql<{ id: string; product_id: string }[]>`select id, product_id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, number: order.number, lineIds: ids.map((l) => l.id) };
  };
  const createDelivery = (orderId: string, extra: Record<string, unknown> = {}) =>
    run<DeliveryOut>(admin, "sales.delivery.create", { orderId, date: day(3, 10), costCenterId, ...extra });
  const ship = (id: string, extra: Record<string, unknown> = {}) => run<DeliveryOut>(admin, "sales.delivery.ship", { id, ...extra });
  const orderStage = async (orderId: string) => (await sql<{ stage: string }[]>`select stage from sales.orders where id = ${orderId}`)[0]!.stage;
  const stock = async (productId: string) => {
    const [row] = await sql<{ on_hand: string | null; reserved: string | null }[]>`
      select sum(on_hand) as on_hand, sum(reserved) as reserved from inventory.v_stock where product_id = ${productId} and warehouse_id = ${warehouseId}`;
    return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0) };
  };
  const issuesOf = (deliveryId: string) => sql<{ id: string; status: string; date: string; kind: string }[]>`
    select id, status, date::text as date, kind from inventory.movements where company_id = ${companyId} and source_entity = 'sales.delivery' and source_id = ${deliveryId}`;
  const layer = async (productId: string) => {
    const [row] = await sql<{ qty: string; value: string }[]>`select qty, value from costing.cost_layers where company_id = ${companyId} and product_id = ${productId} and warehouse_id = ${warehouseId}`;
    return row ? { qty: Number(row.qty), value: Number(row.value) } : null;
  };
  const entriesFor = (eventId: string) => sql<{ id: string; status: string; date: string; total_debit: string; chain_id: string; extra: Record<string, unknown> }[]>`
    select id, status, date::text as date, total_debit, chain_id, extra from accounting.entries where company_id = ${companyId} and source_event_id = ${eventId}`;
  const linesOf = (entryId: string) => sql<{ code: string; debit: string; credit: string; cost_center_id: string | null }[]>`
    select a.code, l.debit, l.credit, l.cost_center_id from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
  const cogsOf = async (deliveryId: string) => {
    const [issue] = await issuesOf(deliveryId);
    return issue ? outbox("costing.cogs.posted", "movementId", issue.id) : [];
  };

  beforeAll(async () => {
    registerCountryPack(co);
    for (const m of [core, inventory, costing, sales, accounting]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, { companies: 2, entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales"] });
    for (const company of seed.companies) {
      for (const id of PROCESS_IDS) {
        await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${company.id}, ${company.adminRoleId}, ${id}) on conflict do nothing`;
      }
    }
    companyId = seed.companies[0]!.id;
    otherCompanyId = seed.companies[1]!.id;
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };

    await runStepUp("accounting.chart.seed", {});
    year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`)[0]!.year;
    await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
    costCenterId = (await sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${companyId}, 'VTA', 'Ventas', 'leaf') returning id`)[0]!.id;

    partyId = (await run<{ id: string }>(admin, "core.party.create", customer("860002964", "Distribuidora Andina S.A.S."))).id;
    await markReady(partyId);
    cafe = await product("CAF-500");
    servicio = await product("SRV-01", { description: "Instalación", kind: "service", trackStock: false, listPrice: 50000, ivaRate: "19" });
    warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
    locationId = (await run<{ id: string }>(admin, "inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
    // 10 @ 100 and 10 @ 120: a weighted average of 110.
    await receive(cafe, 10, 100);
    await receive(cafe, 10, 120);
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

  it("delivers a pedido in two entregas: partial (partially_delivered, the reservation used up by what shipped), then final (delivered)", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 6 }, { productId: servicio, qty: 1 }]);
    const before = await stock(cafe);
    const first = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 2 }] });
    expect(first).toMatchObject({ status: "saved", stage: "open", orderId: order.id, orderStage: "confirmed", lines: [{ lineNo: 1, orderLineId: order.lineIds[0], productId: cafe, qty: 2 }] });
    expect(first.number).toMatch(/^ENT-\d+$/);
    const shipped = await ship(first.id);
    expect(shipped).toMatchObject({ stage: "shipped", orderStage: "partially_delivered" });
    expect(await orderStage(order.id)).toBe("partially_delivered");
    expect(await drain()).toEqual([]);
    expect(await issuesOf(first.id)).toEqual([expect.objectContaining({ status: "saved", kind: "sale_issue", date: day(3, 10) })]);
    expect(await stock(cafe)).toEqual({ onHand: before.onHand - 2, reserved: before.reserved - 2 });
    const [recorded] = await sql<{ movement_id: string | null; stock_posted_at: Date | null }[]>`select movement_id, stock_posted_at from sales.delivery_lines where delivery_id = ${first.id}`;
    expect(recorded!.movement_id).toBe((await issuesOf(first.id))[0]!.id);
    expect(recorded!.stock_posted_at).not.toBeNull();

    // The final entrega takes every line's remainder by default: 4 of café and the service.
    const second = await createDelivery(order.id);
    expect(second.lines.map((l) => [l.orderLineId, l.qty])).toEqual([[order.lineIds[0], 4], [order.lineIds[1], 1]]);
    expect((await ship(second.id)).orderStage).toBe("delivered");
    expect(await drain()).toEqual([]);
    expect(await orderStage(order.id)).toBe("delivered");
    // The service moves no stock: the issue holds the café line only.
    const [issue] = await issuesOf(second.id);
    expect(await sql`select qty::float8 as qty from inventory.movement_lines where movement_id = ${issue!.id}`).toEqual([{ qty: -4 }]);
    expect(await stock(cafe)).toEqual({ onHand: before.onHand - 6, reserved: before.reserved - 6 });
    // A delivered pedido takes no more entregas.
    expect((await refusal(createDelivery(order.id)))?.message).toMatch(/^order_delivered/);
  });

  it("refuses an over-delivery, counting the other entregas of the pedido that are not voided", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 3 }]);
    const over = await refusal(createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 4 }] }));
    expect(over?.code).toBe("invalid_input");
    expect(over?.message).toMatch(/^over_delivery/);
    expect(over?.details).toEqual([expect.stringMatching(/^Línea 1: .*pide 3.*quedan 3/)]);
    await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 2 }] });
    expect((await refusal(createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 2 }] })))?.details).toEqual([expect.stringMatching(/quedan 1/)]);
    // A line of another pedido is refused.
    const otherOrder = await confirmedOrder([{ productId: cafe, qty: 1 }]);
    expect((await refusal(createDelivery(order.id, { lines: [{ orderLineId: otherOrder.lineIds[0], qty: 1 }] })))?.message).toMatch(/^invalid_order_line/);
    // An open (not confirmed) pedido is not delivered.
    const open = await run<{ id: string }>(admin, "sales.order.create", { partyId, issueDate: day(3, 1), warehouseId, lines: [{ productId: cafe, qty: 1, unitPrice: 1 }] });
    expect((await refusal(createDelivery(open.id)))?.message).toMatch(/^order_not_confirmed/);
  });

  it("a shipped entrega gives exactly one sale issue and one Costo de ventas entry dated the entrega, on the entrega's chain; a redelivered event changes nothing", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 2 }]);
    const delivery = await createDelivery(order.id, { date: day(3, 20) });
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    const [shippedRow] = await outbox("sales.delivery.shipped", "deliveryId", delivery.id);
    expect(shippedRow!.payload).toMatchObject({
      deliveryId: delivery.id, number: delivery.number, orderId: order.id, warehouseId, date: day(3, 20), costCenterId,
      lines: [{ lineId: delivery.lines[0]!.id, orderLineId: order.lineIds[0], productId: cafe, qty: 2 }],
    });
    const issues = await issuesOf(delivery.id);
    expect(issues).toHaveLength(1);
    const cogs = await cogsOf(delivery.id);
    expect(cogs).toHaveLength(1);
    expect(cogs[0]!.chain_id).toBe(shippedRow!.chain_id);
    const entries = await entriesFor(cogs[0]!.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "posted", date: day(3, 20), total_debit: "220.0000", chain_id: shippedRow!.chain_id });
    expect(await linesOf(entries[0]!.id)).toEqual([
      { code: "613595", debit: "220.0000", credit: "0.0000", cost_center_id: costCenterId },
      { code: "143505", debit: "0.0000", credit: "220.0000", cost_center_id: null },
    ]);

    // The same event again (the outbox retried it): one movement, the reservation not released twice, one COGS, one entry.
    const reservedBefore = (await stock(cafe)).reserved;
    await redeliver(shippedRow!, "inventory");
    await redeliver((await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.posted' and payload->>'movementId' = ${issues[0]!.id}`)[0]!, "costing");
    expect(await drain()).toEqual([]);
    expect(await issuesOf(delivery.id)).toHaveLength(1);
    expect((await stock(cafe)).reserved).toBe(reservedBefore);
    expect(await cogsOf(delivery.id)).toHaveLength(1);
    expect(await entriesFor(cogs[0]!.id)).toHaveLength(1);
    // Shipping again is refused.
    expect((await refusal(ship(delivery.id)))?.message).toMatch(/^delivery_shipped/);
  });

  it("OD-4: an entrega in a closed period still moves its stock; its COGS is a closed_period posting failure; period.reopen + posting.retry posts it once", async () => {
    const [period] = await sql<{ id: string }[]>`update accounting.periods set status = 'closed' where company_id = ${companyId} and number = 2 returning id`;
    const order = await confirmedOrder([{ productId: cafe, qty: 1 }], day(2, 1));
    const delivery = await createDelivery(order.id, { date: day(2, 15) });
    const before = await stock(cafe);
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    expect((await issuesOf(delivery.id))[0]).toMatchObject({ status: "saved", date: day(2, 15) });
    expect((await stock(cafe)).onHand).toBe(before.onHand - 1);
    const [cogs] = await cogsOf(delivery.id);
    expect(cogs).toBeDefined();
    expect(await entriesFor(cogs!.id)).toEqual([]);
    const failures = await sql<{ id: string; error_code: string; status: string }[]>`select id, error_code, status from accounting.posting_failures where company_id = ${companyId} and event_id = ${cogs!.id}`;
    expect(failures).toEqual([{ id: expect.any(String), error_code: "closed_period", status: "pending" }]);

    await runStepUp("accounting.period.reopen", { periodId: period!.id });
    const retried = await run<{ resolved: boolean; entryId?: string }>(admin, "accounting.posting.retry", { failureId: failures[0]!.id });
    expect(retried.resolved).toBe(true);
    const entries = await entriesFor(cogs!.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "posted", date: day(2, 15), total_debit: "110.0000" });
    // Once: the failure is resolved, a second retry is refused and a redelivery of the COGS event posts nothing more.
    expect(await refusal(run(admin, "accounting.posting.retry", { failureId: failures[0]!.id }))).toMatchObject({ code: "invalid_input" });
    await redeliver(cogs!, "accounting");
    expect(await entriesFor(cogs!.id)).toHaveLength(1);
  });

  it("voids a shipped entrega that nothing invoiced: the stock comes back, the cost layer is restored and the COGS entry is reversed; the pedido steps back", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 3 }]);
    const delivery = await createDelivery(order.id);
    const stockBefore = await stock(cafe);
    const layerBefore = await layer(cafe);
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    expect(await orderStage(order.id)).toBe("delivered");
    const [cogs] = await cogsOf(delivery.id);
    const [entry] = await entriesFor(cogs!.id);
    expect(entry).toBeDefined();

    // Invoiced (Task 16 maintains invoiced_qty): refused, nothing changes.
    await sql`update sales.delivery_lines set invoiced_qty = 1 where delivery_id = ${delivery.id}`;
    const invoiced = await refusal(run(admin, "sales.delivery.void", { id: delivery.id, reason: "Error de despacho" }));
    expect(invoiced?.code).toBe("invalid_state");
    expect(invoiced?.message).toMatch(/^delivery_invoiced/);
    await sql`update sales.delivery_lines set invoiced_qty = 0 where delivery_id = ${delivery.id}`;

    const voided = await run<DeliveryOut>(admin, "sales.delivery.void", { id: delivery.id, reason: "Error de despacho" });
    expect(voided).toMatchObject({ status: "voided", orderStage: "confirmed" });
    expect(await drain()).toEqual([]);
    expect((await issuesOf(delivery.id))[0]!.status).toBe("voided");
    expect((await stock(cafe)).onHand).toBe(stockBefore.onHand);
    expect(await layer(cafe)).toEqual(layerBefore);
    const [issue] = await issuesOf(delivery.id);
    expect(await sql`select kind, qty::float8 as qty, amount::float8 as amount, unit_cost::float8 as unit_cost from costing.cost_events where movement_id = ${issue!.id} order by seq`).toEqual([
      { kind: "sale_issue", qty: -3, amount: -330, unit_cost: 110 },
      { kind: "reversal", qty: 3, amount: 330, unit_cost: 110 },
    ]);
    // The rule `reverseOf` on costing.cogs.voided reverses the COGS entry (the reversal names the entry it reverses).
    expect(await outbox("costing.cogs.voided", "movementId", issue!.id)).toHaveLength(1);
    const reversals = await sql<{ id: string }[]>`select id from accounting.entries where company_id = ${companyId} and reversal_of_id = ${entry!.id}`;
    expect(reversals).toHaveLength(1);
    expect(await linesOf(reversals[0]!.id)).toEqual([
      { code: "613595", debit: "0.0000", credit: "330.0000", cost_center_id: costCenterId },
      { code: "143505", debit: "330.0000", credit: "0.0000", cost_center_id: null },
    ]);
    expect((await sql<{ reversed: boolean }[]>`select coalesce((extra->>'reversed')::boolean, false) as reversed from accounting.entries where id = ${entry!.id}`)[0]!.reversed).toBe(true);
    // The void reached every module once: a redelivery of the voided event changes nothing.
    const [voidedRow] = await outbox("sales.delivery.voided", "deliveryId", delivery.id);
    await redeliver(voidedRow!, "inventory");
    expect(await drain()).toEqual([]);
    expect((await stock(cafe)).onHand).toBe(stockBefore.onHand);
    // A voided entrega no longer counts: the pedido takes a new one.
    expect((await createDelivery(order.id)).lines[0]!.qty).toBe(3);
  });

  it("voiding an entrega whose COGS is still a closed_period failure dismisses the failure: nothing posts later", async () => {
    const [period] = await sql<{ id: string }[]>`update accounting.periods set status = 'closed' where company_id = ${companyId} and number = 2 returning id`;
    const order = await confirmedOrder([{ productId: cafe, qty: 1 }], day(2, 1));
    const delivery = await createDelivery(order.id, { date: day(2, 20) });
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    const [cogs] = await cogsOf(delivery.id);
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "No salió" });
    expect(await drain()).toEqual([]);
    const failures = await sql<{ status: string }[]>`select status from accounting.posting_failures where company_id = ${companyId} and event_id = ${cogs!.id}`;
    expect(failures).toEqual([{ status: "dismissed" }]);
    await runStepUp("accounting.period.reopen", { periodId: period!.id });
    expect(await entriesFor(cogs!.id)).toEqual([]);
  });

  it("a devolución puts the stock back at the original issue's cost (not today's average) and takes that cost out of the cost of sales", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 4 }]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    const [issue] = await issuesOf(delivery.id);
    const issued = (await sql<{ unit_cost: string }[]>`select unit_cost from costing.cost_events where movement_id = ${issue!.id} and kind = 'sale_issue'`)[0]!.unit_cost;
    // A dearer receipt moves the average away from the issue's cost.
    await receive(cafe, 10, 200, day(3, 25));
    const ret = await run<ReturnOut>(admin, "sales.return.create", { deliveryId: delivery.id, date: day(3, 26), reason: "Empaque dañado", lines: [{ deliveryLineId: delivery.lines[0]!.id, qty: 1 }] });
    expect(ret).toMatchObject({ status: "saved", stage: "open" });
    expect(ret.number).toMatch(/^DEV-\d+$/);
    const before = await stock(cafe);
    const received = await run<ReturnOut>(admin, "sales.return.receive", { id: ret.id });
    expect(received.stage).toBe("received");
    expect(await drain()).toEqual([]);
    expect((await stock(cafe)).onHand).toBe(before.onHand + 1);
    const [back] = await sql<{ id: string }[]>`select id from inventory.movements where source_entity = 'sales.return' and source_id = ${ret.id} and kind = 'sale_return'`;
    expect(await sql`select cost_source, unit_cost, qty::float8 as qty from costing.cost_events where movement_id = ${back!.id}`).toEqual([{ cost_source: "original_issue", unit_cost: issued, qty: 1 }]);
    const [returned] = await outbox("costing.cogs.returned", "movementId", back!.id);
    const entries = await entriesFor(returned!.id);
    expect(entries).toHaveLength(1);
    expect(await linesOf(entries[0]!.id)).toEqual([
      { code: "143505", debit: "110.0000", credit: "0.0000", cost_center_id: null },
      { code: "613595", debit: "0.0000", credit: "110.0000", cost_center_id: costCenterId },
    ]);
    // More than was delivered is refused (4 delivered, 1 returned: 3 left); the entrega with a devolución is not voided.
    const over = await refusal(run(admin, "sales.return.create", { deliveryId: delivery.id, date: day(3, 26), reason: "x", lines: [{ deliveryLineId: delivery.lines[0]!.id, qty: 4 }] }));
    expect(over?.message).toMatch(/^over_return/);
    expect((await refusal(run(admin, "sales.delivery.void", { id: delivery.id, reason: "x" })))?.message).toMatch(/^delivery_returned/);
  });

  it("refuses cancelling (or voiding) a pedido once it has an entrega", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 2 }]);
    const delivery = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] });
    expect((await refusal(run(admin, "sales.order.cancel", { id: order.id, reason: "El cliente desistió" })))?.message).toMatch(/^order_has_deliveries/);
    await ship(delivery.id);
    const cancel = await refusal(run(admin, "sales.order.cancel", { id: order.id, reason: "El cliente desistió" }));
    expect(cancel?.code).toBe("invalid_state");
    expect(cancel?.message).toMatch(/^order_delivered/);
    expect((await refusal(run(admin, "sales.order.void", { id: order.id, reason: "x" })))?.message).toMatch(/^order_delivered/);
    expect(await orderStage(order.id)).toBe("partially_delivered");
    expect(await outbox("sales.order.cancelled", "orderId", order.id)).toEqual([]);
  });

  it("checks the stock on hand at ship, not the reservation: a short line, or stock reserved for another pedido, is refused with negative_stock_refused", async () => {
    const tostado = await product("TOS-250");
    await receive(tostado, 3, 50);
    const first = await confirmedOrder([{ productId: tostado, qty: 3 }]);
    // Confirmed while the stock is all reserved: the line is short (reserves nothing).
    const short = await confirmedOrder([{ productId: tostado, qty: 2 }]);
    expect(await stock(tostado)).toEqual({ onHand: 3, reserved: 3 });
    const refused = await refusal(ship((await createDelivery(short.id)).id));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^negative_stock_refused/);
    expect(refused?.details).toEqual([expect.stringMatching(/TOS-250/)]);
    // The pedido that holds the reservation ships.
    await ship((await createDelivery(first.id)).id);
    expect(await drain()).toEqual([]);
    expect(await stock(tostado)).toEqual({ onHand: 0, reserved: 0 });
  });

  it("two entregas of the last unit shipped at once: one ships, the other is refused before any stock moves", async () => {
    const molido = await product("MOL-125");
    await receive(molido, 1, 80);
    const order = await confirmedOrder([{ productId: molido, qty: 2 }]);
    const a = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] });
    const b = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] });
    const results = await Promise.all([ship(a.id).then(() => "ok", (e: ProcessError) => e.message), ship(b.id).then(() => "ok", (e: ProcessError) => e.message)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.find((r) => r !== "ok")).toMatch(/^negative_stock_refused/);
    expect(await drain()).toEqual([]);
    expect(await stock(molido)).toEqual({ onHand: 0, reserved: 0 });
  });

  it("re-checks the customer and every product at ship (rule 10)", async () => {
    const molde = await product("MOL-RDY");
    await receive(molde, 2, 10);
    const order = await confirmedOrder([{ productId: molde, qty: 1 }]);
    const delivery = await createDelivery(order.id);
    await sql`update core.products set dian_status = 'missing: 1', dian_missing = '{"Código estándar"}' where id = ${molde}`;
    const refused = await refusal(ship(delivery.id));
    expect(refused?.message).toMatch(/^not_invoice_ready/);
    expect((await sql<{ stage: string }[]>`select stage from sales.deliveries where id = ${delivery.id}`)[0]!.stage).toBe("open");
  });

  it("an unshipped entrega is voided without any event; its lines are not changed once shipped", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 1 }]);
    const delivery = await createDelivery(order.id);
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "Duplicada" });
    expect(await outbox("sales.delivery.voided", "deliveryId", delivery.id)).toEqual([]);
    const next = await createDelivery(order.id);
    await ship(next.id);
    expect(await refusal(sql`update sales.delivery_lines set qty = 5 where delivery_id = ${next.id}`)).toMatchObject({ message: expect.stringMatching(/despachada o anulada no cambian/) });
    expect(await refusal(run(admin, "sales.delivery.save", { id: next.id, data: { notes: "x" } }))).toMatchObject({ code: "invalid_state" });
    expect(await drain()).toEqual([]);
  });
  // ---------------------------------------------------------------------------------------------------------------------------------------
  // Task 14 review: the ship check mirrors the stock move, a refusal by inventory is never silent, the void of a devolución is checked.
  // ---------------------------------------------------------------------------------------------------------------------------------------
  const issueAway = (productId: string, qty: number, location: string | null = locationId) =>
    run(admin, "inventory.movement.post", { kind: "issue", date: day(3, 12), warehouseId, lines: [{ productId, ...(location ? { locationId: location } : {}), qty: -qty }] });
  const deliveryRow = async (id: string) =>
    (await sql<{ stage: string; status: string; shipped_at: Date | null; stock_refusal: string | null; stock_refused_at: Date | null }[]>`
      select stage, status, shipped_at, stock_refusal, stock_refused_at from sales.deliveries where id = ${id}`)[0]!;
  const pendingCount = async (productId: string) =>
    Number((await sql<{ n: string }[]>`
      select coalesce(sum(l.qty), 0)::text as n from sales.delivery_lines l join sales.deliveries d on d.id = l.delivery_id
      where d.company_id = ${companyId} and d.stage = 'shipped' and d.status <> 'voided' and l.stock_posted_at is null and l.product_id = ${productId}`)[0]!.n);

  it("refuses at ship (split_location) a line no single ubicación holds: 1 in A1 and 1 in the bodega itself do not make an entrega of 2", async () => {
    const split = await product("SPL-01");
    await run(admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [{ productId: split, locationId, qty: 1, unitCost: 50 }] });
    await run(admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [{ productId: split, qty: 1, unitCost: 50 }] });
    expect(await drain()).toEqual([]);
    const order = await confirmedOrder([{ productId: split, qty: 2 }]);
    const delivery = await createDelivery(order.id);
    const refused = await refusal(ship(delivery.id));
    expect(refused?.code).toBe("invalid_input");
    expect(refused?.message).toMatch(/^split_location/);
    expect(refused?.details).toEqual([expect.stringMatching(/SPL-01.*una sola ubicación/)]);
    expect((await deliveryRow(delivery.id)).stage).toBe("open");
    // One unit per entrega leaves from one ubicación each.
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "Se parte en dos" });
    // The check counts an entrega shipped but not yet issued against the largest bucket (conservative: inventory picks its bucket when it
    // issues), so the second ships once the first was issued.
    for (let i = 0; i < 2; i++) {
      await ship((await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] })).id);
      expect(await drain()).toEqual([]);
    }
    expect(await stock(split)).toEqual({ onHand: 0, reserved: 0 });
    expect(await orderStage(order.id)).toBe("delivered");
  });

  it("stock taken between ship and the issue: inventory refuses by event, the entrega goes back to open with the reason, nothing stays pending, the pedido steps back; ship again and void both work", async () => {
    const gone = await product("GON-01");
    await receive(gone, 2, 60);
    const order = await confirmedOrder([{ productId: gone, qty: 2 }]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    expect(await orderStage(order.id)).toBe("delivered");
    expect(await pendingCount(gone)).toBe(2);
    // A non-sales issue takes the stock before inventory issued the entrega.
    await issueAway(gone, 2);
    // Never dead-lettered: inventory acknowledges with inventory.sale_issue.refused and sales reopens the entrega.
    expect(await drain()).toEqual([]);
    expect(await issuesOf(delivery.id)).toEqual([]);
    const [refusedRow] = await outbox("inventory.sale_issue.refused", "deliveryId", delivery.id);
    expect(refusedRow!.payload).toMatchObject({ deliveryId: delivery.id, code: "negative_stock_refused" });
    const row = await deliveryRow(delivery.id);
    expect(row).toMatchObject({ stage: "open", status: "saved", shipped_at: null });
    expect(row.stock_refusal).toMatch(/^negative_stock_refused: .*GON-01/);
    expect(row.stock_refused_at).not.toBeNull();
    expect(await pendingCount(gone)).toBe(0);
    expect(await orderStage(order.id)).toBe("confirmed");
    // The product is not blocked: stock back, the same entrega ships again (the reason cleared) and is issued.
    await receive(gone, 2, 60);
    await ship(delivery.id);
    expect((await deliveryRow(delivery.id)).stock_refusal).toBeNull();
    expect(await drain()).toEqual([]);
    expect(await issuesOf(delivery.id)).toEqual([expect.objectContaining({ status: "saved" })]);
    // The old refusal, redelivered, does not undo the later despacho.
    await redeliver(refusedRow!, "sales");
    expect((await deliveryRow(delivery.id)).stage).toBe("shipped");
    // And the void works.
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "Cliente no recibió" });
    expect(await drain()).toEqual([]);
    expect((await issuesOf(delivery.id))[0]!.status).toBe("voided");
    expect((await stock(gone)).onHand).toBe(2);
  });

  it("an unshipped entrega reopened by a refusal is voided without any stock move", async () => {
    const lone = await product("LON-01");
    await receive(lone, 1, 70);
    const order = await confirmedOrder([{ productId: lone, qty: 1 }]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    await issueAway(lone, 1);
    expect(await drain()).toEqual([]);
    expect((await deliveryRow(delivery.id)).stage).toBe("open");
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "Sin mercancía" });
    expect(await drain()).toEqual([]);
    expect(await issuesOf(delivery.id)).toEqual([]);
    expect(await pendingCount(lone)).toBe(0);
  });

  it("the void of a received devolución checks the stock it takes back out (negative_stock_refused); a refusal by inventory after the check puts it back to received with the reason; the void then reverses the return's cost of sales", async () => {
    const back = await product("BCK-01");
    await receive(back, 2, 90);
    const order = await confirmedOrder([{ productId: back, qty: 2 }]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    expect(await drain()).toEqual([]);
    const ret = await run<ReturnOut>(admin, "sales.return.create", { deliveryId: delivery.id, date: day(3, 26), reason: "Sobrante", lines: [{ deliveryLineId: delivery.lines[0]!.id, qty: 1 }] });
    await run(admin, "sales.return.receive", { id: ret.id });
    expect(await drain()).toEqual([]);
    const [backIn] = await sql<{ id: string }[]>`select id from inventory.movements where source_entity = 'sales.return' and source_id = ${ret.id}`;
    const [returned] = await outbox("costing.cogs.returned", "movementId", backIn!.id);
    const [returnEntry] = await entriesFor(returned!.id);
    expect(returnEntry).toMatchObject({ status: "posted" });

    // The unit that came back left again: the void is refused at sales, nothing changes.
    await issueAway(back, 1);
    expect(await drain()).toEqual([]);
    const refused = await refusal(run(admin, "sales.return.void", { id: ret.id, reason: "Error" }));
    expect(refused?.message).toMatch(/^negative_stock_refused/);
    expect(refused?.details).toEqual([expect.stringMatching(/BCK-01/)]);
    expect((await sql<{ status: string }[]>`select status from sales.returns where id = ${ret.id}`)[0]!.status).toBe("saved");

    // Stock again, the check passes, and the stock goes before inventory voids: inventory refuses by event, sales restores the devolución.
    await receive(back, 1, 90);
    await run(admin, "sales.return.void", { id: ret.id, reason: "Error" });
    await issueAway(back, 1);
    expect(await drain()).toEqual([]);
    const restored = (await sql<{ status: string; stage: string; void_reason: string | null; stock_refusal: string | null }[]>`
      select status, stage, void_reason, stock_refusal from sales.returns where id = ${ret.id}`)[0]!;
    expect(restored).toMatchObject({ status: "saved", stage: "received", void_reason: null });
    expect(restored.stock_refusal).toMatch(/^negative_stock_refused: /);
    expect((await sql<{ status: string }[]>`select status from inventory.movements where id = ${backIn!.id}`)[0]!.status).toBe("saved");

    // With the stock there, the void goes through end to end: the movement voided, costing.cogs.return_voided, the return's entry reversed.
    await receive(back, 1, 90);
    await run(admin, "sales.return.void", { id: ret.id, reason: "Error" });
    expect(await drain()).toEqual([]);
    expect((await sql<{ status: string }[]>`select status from inventory.movements where id = ${backIn!.id}`)[0]!.status).toBe("voided");
    expect(await outbox("costing.cogs.return_voided", "movementId", backIn!.id)).toHaveLength(1);
    const reversals = await sql<{ id: string; status: string }[]>`select id, status from accounting.entries where reversal_of_id = ${returnEntry!.id}`;
    expect(reversals).toEqual([{ id: expect.any(String), status: "posted" }]);
    expect(await linesOf(reversals[0]!.id)).toEqual([
      { code: "143505", debit: "0.0000", credit: "90.0000", cost_center_id: null },
      { code: "613595", debit: "90.0000", credit: "0.0000", cost_center_id: costCenterId },
    ]);
  });

  it("the last unit, two pedidos at once: one entrega ships, the other is refused before any stock moves", async () => {
    const last = await product("LST-01");
    // Both pedidos confirm while there is no stock (neither reserves), then one unit arrives: each alone would ship.
    const a = await confirmedOrder([{ productId: last, qty: 1 }]);
    const b = await confirmedOrder([{ productId: last, qty: 1 }]);
    await receive(last, 1, 40);
    const da = await createDelivery(a.id);
    const db = await createDelivery(b.id);
    const results = await Promise.all([ship(da.id).then(() => "ok", (e: ProcessError) => e.message), ship(db.id).then(() => "ok", (e: ProcessError) => e.message)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.find((r) => r !== "ok")).toMatch(/^negative_stock_refused/);
    expect(await drain()).toEqual([]);
    expect(await stock(last)).toEqual({ onHand: 0, reserved: 0 });
  });

  it("an entrega voided before inventory consumed its despacho: the void waits for the issue (retried), then reverses it", async () => {
    const early = await product("ERL-01");
    await receive(early, 3, 30);
    const order = await confirmedOrder([{ productId: early, qty: 1 }]);
    const delivery = await createDelivery(order.id);
    await ship(delivery.id);
    await run(admin, "sales.delivery.void", { id: delivery.id, reason: "Anulada al instante" });
    // The void reaches inventory first: nothing issued yet and no refusal, so it is retried later rather than lost.
    const [voidedRow] = await outbox("sales.delivery.voided", "deliveryId", delivery.id);
    await expect(redeliver(voidedRow!, "inventory")).rejects.toMatchObject({ code: "handler_failed" });
    expect(await drain()).toEqual([]);
    expect((await issuesOf(delivery.id))[0]!.status).toBe("voided");
    expect(await stock(early)).toEqual({ onHand: 3, reserved: 0 });
    const [cogs] = await cogsOf(delivery.id);
    // The ledger nets to zero whichever reached accounting first: the entry and its reversal, or (the void first) the event dismissed and
    // nothing posted, no pending left (accounting.posting.reverse_source).
    const entries = await entriesFor(cogs!.id);
    if (entries.length > 0) expect(await sql`select 1 from accounting.entries where reversal_of_id = ${entries[0]!.id}`).toHaveLength(1);
    else expect(await sql`select 1 from accounting.posting_failures where event_id = ${cogs!.id} and status = 'pending'`).toEqual([]);
  });

  it("two despachos of the same lines issued at once (a duplicated event): one movement, the other run finds it (duplicate_source_line), the reservation used up once", async () => {
    const dup = await product("DUP-01");
    await receive(dup, 10, 25);
    // A PARTIAL entrega: the pedido reserves 10, ships 4, so exactly 6 stay reserved however often the despacho arrives.
    const order = await confirmedOrder([{ productId: dup, qty: 10 }]);
    expect(await stock(dup)).toEqual({ onHand: 10, reserved: 10 });
    const delivery = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 4 }] });
    await ship(delivery.id);
    const [shippedRow] = await outbox("sales.delivery.shipped", "deliveryId", delivery.id);
    const duplicate = async () => {
      const copyId = await sql.begin((tx) => enqueueEvent(tx, { companyId, event: shippedRow!.event, payload: shippedRow!.payload, chainId: shippedRow!.chain_id }));
      return (await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where id = ${copyId}`)[0]!;
    };
    const copy = await duplicate();
    await Promise.all([redeliver(shippedRow!, "inventory"), redeliver(copy, "inventory")]);
    expect(await issuesOf(delivery.id)).toHaveLength(1);
    expect(await stock(dup)).toEqual({ onHand: 6, reserved: 6 });
    // A third copy, later and alone: it finds the movement and releases nothing.
    await redeliver(await duplicate(), "inventory");
    expect(await stock(dup)).toEqual({ onHand: 6, reserved: 6 });
    expect(await drain()).toEqual([]);
    expect(await issuesOf(delivery.id)).toHaveLength(1);
    expect(await cogsOf(delivery.id)).toHaveLength(1);
    expect(await stock(dup)).toEqual({ onHand: 6, reserved: 6 });
  });

  it("the customer's credit counts delivered pedidos: a delivered pedido still uses the limit (INTERIM until invoicing)", async () => {
    const limited = (await run<{ id: string }>(admin, "core.party.create", customer("900555666", "Café Limitado S.A.S."))).id;
    await markReady(limited);
    await run(admin, "sales.customer_terms.set", { partyId: limited, creditLimit: 30000 });
    const first = await run<{ id: string }>(admin, "sales.order.create", { partyId: limited, issueDate: day(3, 1), warehouseId, lines: [{ productId: cafe, qty: 1, unitPrice: 20000 }] });
    await run(admin, "sales.order.confirm", { id: first.id });
    expect(await drain()).toEqual([]);
    await ship((await createDelivery(first.id)).id);
    expect(await drain()).toEqual([]);
    expect(await orderStage(first.id)).toBe("delivered");
    // 21.000 delivered + 21.000 more exceeds 30.000: the second pedido waits for approval.
    const second = await run<{ id: string; status: string; creditExceeded: boolean; stage: string }>(admin, "sales.order.create", { partyId: limited, issueDate: day(3, 2), warehouseId, lines: [{ productId: cafe, qty: 1, unitPrice: 20000 }] });
    expect(second).toMatchObject({ status: "pending", stage: "open", creditExceeded: true });
    expect((await refusal(run(admin, "sales.order.confirm", { id: second.id })))?.message).toMatch(/^order_pending_approval/);
  });

  it("the database refuses voiding an entrega with invoiced units, and invoicing a voided entrega, whoever writes", async () => {
    const order = await confirmedOrder([{ productId: cafe, qty: 2 }]);
    const shippedOne = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] });
    await ship(shippedOne.id);
    expect(await drain()).toEqual([]);
    await sql`update sales.delivery_lines set invoiced_qty = 1 where delivery_id = ${shippedOne.id}`;
    expect(await refusal(sql`update sales.deliveries set status = 'voided', void_reason = 'x' where id = ${shippedOne.id}`)).toMatchObject({ message: expect.stringMatching(/unidades facturadas no se anula/) });
    await sql`update sales.delivery_lines set invoiced_qty = 0 where delivery_id = ${shippedOne.id}`;
    const voidedOne = await createDelivery(order.id, { lines: [{ orderLineId: order.lineIds[0], qty: 1 }] });
    await run(admin, "sales.delivery.void", { id: voidedOne.id, reason: "x" });
    expect(await refusal(sql`update sales.delivery_lines set invoiced_qty = 1 where delivery_id = ${voidedOne.id}`)).toMatchObject({ message: expect.stringMatching(/anulada no se factura/) });
  });
});
