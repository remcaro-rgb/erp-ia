import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, withClaims, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sales } from "../index";
import { DELIVERY_PRINT_LINE_COLUMNS, deliveryRecordTemplate } from "../print";

// Lots on deliveries and returns (plan 2B.2 Task 28.3, PG §3.3; RG-4, Review Focus 1 and 2, migrations 0164–0165): the whole chain with the
// real modules. A lot-only product confirms, reserves and ships; inventory issues it by FEFO and answers inventory.sale_issue.allocated;
// sales.delivery.record_lots writes sales.delivery_line_lots once per event, published in sales.v_delivery_line_lots and printed on the
// remisión («Lote / Vence / Serie»). A delivery line naming an expired lot is refused at ship (lot_expired). A devolución line defaults
// its lot from what the entrega issued. Every event is handed to its consumers as the dispatch workflow does (`drain`).

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

describe("lots on deliveries and returns (Task 28.3)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let admin: Caller;
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
  const reserved = async (orderLineId: string) =>
    Number((await sql<{ n: string }[]>`select coalesce(sum(qty - released_qty), 0)::text as n from inventory.reservations where company_id = ${companyId} and source_line_id = ${orderLineId} and status = 'active'`)[0]!.n);
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

  /** A lot product with lots A (expires next year 12-01, 4) and B (next year 06-01, 3) and an expired lot C (this year 02-01, 2). */
  const lotProduct = async () => {
    const productId = (await run<{ id: string }>(admin, "core.product.create", good(`LOT-${randomUUID().slice(0, 8)}`))).id;
    await runStepUp("inventory.product_tracking.set", { productId, tracking: "lot" });
    await run(admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [
      { productId, locationId, qty: 4, unitCost: 100, lot: { code: "A", expiresOn: `${year + 1}-12-01` } },
      { productId, locationId, qty: 3, unitCost: 100, lot: { code: "B", expiresOn: `${year + 1}-06-01` } },
      { productId, locationId, qty: 2, unitCost: 100, lot: { code: "C", expiresOn: `${year}-02-01` } },
    ] });
    expect(await drain()).toEqual([]);
    const lots = await sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${productId}`;
    return { productId, lot: Object.fromEntries(lots.map((l) => [l.code, l.id])) as Record<string, string> };
  };
  const lotRows = (deliveryLineId: string) =>
    sql<{ lot_code: string | null; expires_on: string | null; qty: string }[]>`
      select lot_code, expires_on::text, qty::text from sales.delivery_line_lots where delivery_line_id = ${deliveryLineId} order by seq`;

  it("Review Focus 2: a lot-only product confirms, reserves and ships by FEFO; delivery_line_lots is written once per event and published; the remisión prints the lots", async () => {
    const p = await lotProduct();
    const order = await confirmedOrder([{ productId: p.productId, qty: 5 }]);
    expect(await reserved(order.lineIds[0]!)).toBe(5);
    const delivery = await shippedDelivery(order.id);
    expect(delivery.stage).toBe("open");
    const [line] = await sql<{ id: string; stock_posted_at: Date | null }[]>`select id, stock_posted_at from sales.delivery_lines where delivery_id = ${delivery.id}`;
    expect(line!.stock_posted_at).not.toBeNull();
    // FEFO: B (expires first) then A; C is expired and skipped.
    expect((await lotRows(line!.id)).map((r) => [r.lot_code, r.expires_on, Number(r.qty)])).toEqual([["B", `${year + 1}-06-01`, 3], ["A", `${year + 1}-12-01`, 2]]);
    expect(await reserved(order.lineIds[0]!)).toBe(0);
    // A redelivered allocated event writes nothing new.
    const [allocated] = await outbox("inventory.sale_issue.allocated", "deliveryId", delivery.id);
    await redeliver(allocated!, "sales");
    expect(await lotRows(line!.id)).toHaveLength(2);
    // Published for invoicing (28.4) and read as the caller.
    const published = await withClaims(sql, admin.claims, (tx) => tx<{ lot_code: string; qty: string }[]>`
      select lot_code, qty::text from sales.v_delivery_line_lots where delivery_line_id = ${line!.id} order by lot_code`);
    expect(published.map((r) => [r.lot_code, Number(r.qty)])).toEqual([["A", 2], ["B", 3]]);
    // The remisión's lines table prints «Lote / Vence / Serie».
    expect(DELIVERY_PRINT_LINE_COLUMNS).toContain("lots");
    const template = deliveryRecordTemplate({ title: "Entrega" });
    expect(JSON.stringify(template.blocks)).toContain("\"lots\"");
    const [view] = await withClaims(sql, admin.claims, (tx) => tx<{ lots: string | null }[]>`select lots from sales.v_delivery_lines where id = ${line!.id}`);
    expect(view!.lots).toBe(`B · ${year + 1}-06-01 · 3; A · ${year + 1}-12-01 · 2`);
  });

  it("a delivery line naming lot A ships it (the shipped event carries lotId); naming the expired lot C is refused lot_expired at ship", async () => {
    const p = await lotProduct();
    const order = await confirmedOrder([{ productId: p.productId, qty: 3 }]);
    const named = await run<DeliveryOut>(admin, "sales.delivery.create", { orderId: order.id, date: day(3, 10), costCenterId, lines: [{ orderLineId: order.lineIds[0]!, qty: 2, lotId: p.lot.A }] });
    await run(admin, "sales.delivery.ship", { id: named.id });
    const [shipped] = await outbox("sales.delivery.shipped", "deliveryId", named.id);
    expect((shipped!.payload.lines as { lotId?: string }[])[0]!.lotId).toBe(p.lot.A);
    expect(await drain()).toEqual([]);
    expect((await lotRows(named.lines[0]!.id)).map((r) => [r.lot_code, Number(r.qty)])).toEqual([["A", 2]]);
    const expired = await run<DeliveryOut>(admin, "sales.delivery.create", { orderId: order.id, date: day(3, 10), costCenterId, lines: [{ orderLineId: order.lineIds[0]!, qty: 1, lotId: p.lot.C }] });
    const refused = await refusal(run(admin, "sales.delivery.ship", { id: expired.id }));
    expect(refused).toMatchObject({ code: "invalid_input", message: expect.stringMatching(/^lot_expired/) });
    // A lot of another product is refused when the line is written.
    const other = await lotProduct();
    expect(await refusal(run(admin, "sales.delivery.update", { id: expired.id, lines: [{ orderLineId: order.lineIds[0]!, qty: 1, lotId: other.lot.A }] })))
      .toMatchObject({ code: "invalid_input" });
  });

  it("a devolución line defaults its lot from what the entrega issued and the stock re-enters that lot", async () => {
    const p = await lotProduct();
    const order = await confirmedOrder([{ productId: p.productId, qty: 2 }]);
    const delivery = await run<DeliveryOut>(admin, "sales.delivery.create", { orderId: order.id, date: day(3, 10), costCenterId, lines: [{ orderLineId: order.lineIds[0]!, qty: 2, lotId: p.lot.A }] });
    await run(admin, "sales.delivery.ship", { id: delivery.id });
    expect(await drain()).toEqual([]);
    const ret = await run<{ id: string }>(admin, "sales.return.create", { deliveryId: delivery.id, reason: "Empaque roto", date: day(3, 12), lines: [{ deliveryLineId: delivery.lines[0]!.id, qty: 1 }] });
    const [returnLine] = await sql<{ lot_id: string | null }[]>`select lot_id from sales.return_lines where return_id = ${ret.id}`;
    expect(returnLine!.lot_id).toBe(p.lot.A);
    await run(admin, "sales.return.receive", { id: ret.id });
    const [received] = await outbox("sales.return.received", "returnId", ret.id);
    expect((received!.payload.lines as { lotId?: string }[])[0]!.lotId).toBe(p.lot.A);
    expect(await drain()).toEqual([]);
    const [bucket] = await sql<{ on_hand: string }[]>`select on_hand::text from inventory.stock_levels where lot_id = ${p.lot.A!} and location_id = ${locationId}`;
    expect(Number(bucket!.on_hand)).toBe(3);
  });
});
