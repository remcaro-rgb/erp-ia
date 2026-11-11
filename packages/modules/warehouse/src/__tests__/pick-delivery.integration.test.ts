import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, moduleGate, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { warehouse } from "../index";

// The entrega from an alistamiento and the ship from the allocation (plan 2B.2 Task 29.2, PG §4.3 steps 4–5; RG-8, Review Focus 3), with
// the real modules. Sales acts on inventory's answer (inventory.reservation.allocated), never on the pick: `allocated` with createDelivery
// (warehouse's delivery_from_pick) leaves one open entrega with the picked lots and serials, linked to the alistamiento (pick_to_delivery)
// and to the pedido (order_to_delivery); `short` leaves none. At ship, inventory issues from the reservation's allocations (the ubicación,
// lot and serial the picker took) before anything else, then by FEFO (RG-4) or, untracked, from one bucket as before (RG-2). A manual
// entrega without an alistamiento ships by FEFO as in 28.3; voiding the entrega gives the stock back to the buckets it left (the allocated
// ones) and Task 43's re-reservation keeps working. Every event is handed to its consumers as the dispatch workflow does (`drain`, with the
// dispatcher's module gate, as pick.integration.test.ts).

const registry = new Registry();
const MODULES = [kernelModule, core, accounting, inventory, costing, sales, warehouse];
loadModules(registry, MODULES);
const PROCESS_IDS = ["core", "accounting", "inventory", "costing", "sales", "warehouse"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id);
const LOADED = new Set(MODULES.map((m) => m.id));

const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, ...overrides,
});
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
interface PickRow { id: string; number: string | null; status: string; stage: string; allocation_status: string | null }
interface DeliveryRow { id: string; number: string | null; status: string; stage: string }
interface DeliveryLine { id: string; order_line_id: string; product_id: string; qty: string; lot_id: string | null; serial_ids: string[] | null }
type Bucket = [productId: string, locationId: string | null, lotId: string | null, serialId: string | null, qty: number];

describe("the entrega from an alistamiento and the ship from the allocation (Task 29.2)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let companyId: string;
  let admin: Caller;
  let partyId: string;
  let warehouseId: string;
  let year: number;
  let l1: string;
  let l2: string;
  let lotProduct: string;
  let plainProduct: string;
  let serialProduct: string;
  let lot: Record<string, string>;
  let serial: Record<string, string>;

  const run = <T = unknown>(processId: string, input: unknown) => runProcess({ sql, registry }, admin, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${admin.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...admin, stepUpToken }, processId, input) as Promise<T>;
  };
  const day = (month: number, d = 15) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  /** Every undispatched event of the company to its consumers, as the dispatch workflow does (pick.integration.test.ts's drain). */
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
          if ((await moduleGate(sql, companyId, consumer.moduleId)) === "not_purchased") continue;
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            ok = false;
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!ok) failed.add(row.id);
        else await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id}`;
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

  const confirmedOrder = async (lines: { productId: string; qty: number }[]) => {
    const order = await run<{ id: string }>("sales.order.create", { partyId, issueDate: day(3, 1), warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run("sales.order.confirm", { id: order.id });
    expect(await drain()).toEqual([]);
    const ids = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, lineIds: ids.map((l) => l.id) };
  };
  const pickOf = async (orderId: string) =>
    (await sql<PickRow[]>`select id, number, status, stage, allocation_status from warehouse.picks where order_id = ${orderId} and status <> 'voided' order by seq`)[0]!;
  const pickLines = (pickId: string) =>
    sql<{ id: string; order_line_id: string; product_id: string; location_id: string | null; lot_id: string | null; qty_requested: string }[]>`
      select id, order_line_id, product_id, location_id, lot_id, qty_requested::text from warehouse.pick_lines where pick_id = ${pickId} order by line_no`;
  const deliveriesOf = (orderId: string) =>
    sql<DeliveryRow[]>`select id, number, status, stage from sales.deliveries where order_id = ${orderId} order by seq`;
  const deliveryLines = (deliveryId: string) =>
    sql<DeliveryLine[]>`select id, order_line_id, product_id, qty::text, lot_id, serial_ids::text[] as serial_ids from sales.delivery_lines where delivery_id = ${deliveryId} order by line_no`;
  const sortBuckets = (rows: Bucket[]) => [...rows].sort((x, y) => x.map(String).join("|").localeCompare(y.map(String).join("|")));
  const allocations = async (orderLineIds: string[]): Promise<Bucket[]> =>
    sortBuckets((await sql<{ product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string }[]>`
      select r.product_id, a.location_id, a.lot_id, a.serial_id, a.qty::text
      from inventory.reservation_allocations a join inventory.reservations r on r.id = a.reservation_id
      where r.source_line_id = any(${orderLineIds}::uuid[])`).map((r) => [r.product_id, r.location_id, r.lot_id, r.serial_id, Number(r.qty)]));
  /** The movement lines of an entrega's sale issue, as positive quantities per bucket. */
  const issued = async (deliveryId: string): Promise<Bucket[]> =>
    sortBuckets((await sql<{ product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string }[]>`
      select l.product_id, l.location_id, l.lot_id, l.serial_id, (-l.qty)::text as qty
      from inventory.movement_lines l join inventory.movements m on m.id = l.movement_id
      where m.company_id = ${companyId} and m.source_entity = 'sales.delivery' and m.source_id = ${deliveryId} and m.kind = 'sale_issue'`).map((r) => [r.product_id, r.location_id, r.lot_id, r.serial_id, Number(r.qty)]));
  const onHand = async (productId: string, locationId: string, lotId: string | null = null, serialId: string | null = null) =>
    Number((await sql<{ q: string }[]>`
      select coalesce(sum(on_hand), 0)::text as q from inventory.stock_levels where company_id = ${companyId} and product_id = ${productId}
        and location_id = ${locationId} and lot_id is not distinct from ${lotId}::uuid and serial_id is not distinct from ${serialId}::uuid`)[0]!.q);
  const linksInto = (deliveryId: string) =>
    sql<{ kind: string; from_entity: string; from_id: string }[]>`
      select kind, from_entity, from_id from kernel.document_links where company_id = ${companyId} and to_entity = 'sales.delivery' and to_id = ${deliveryId} order by kind`;

  beforeAll(async () => {
    registerCountryPack(co);
    for (const m of [core, inventory, costing, sales, accounting, warehouse]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, {
      companies: 1,
      entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:warehouse"],
    });
    companyId = seed.companies[0]!.id;
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id}) on conflict do nothing`;
    }
    admin = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
    await runStepUp("accounting.chart.seed", {});
    const [fy] = await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`;
    year = fy!.year;
    await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
    partyId = (await run<{ id: string }>("core.party.create", customer("860002964", "Distribuidora del Norte S.A.S."))).id;
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${partyId}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${partyId}/${randomUUID()}.pdf`})`;
    }
    warehouseId = (await run<{ id: string }>("inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
    l1 = (await run<{ id: string }>("inventory.location.create", { warehouseId, code: "A1", name: "Estante A1" })).id;
    l2 = (await run<{ id: string }>("inventory.location.create", { warehouseId, code: "B1", name: "Estante B1" })).id;
    lotProduct = (await run<{ id: string }>("core.product.create", good(`LOT-${randomUUID().slice(0, 8)}`))).id;
    plainProduct = (await run<{ id: string }>("core.product.create", good(`UNT-${randomUUID().slice(0, 8)}`))).id;
    serialProduct = (await run<{ id: string }>("core.product.create", good(`SER-${randomUUID().slice(0, 8)}`))).id;
    await runStepUp("inventory.product_tracking.set", { productId: lotProduct, tracking: "lot" });
    await runStepUp("inventory.product_tracking.set", { productId: serialProduct, tracking: "serial" });
    await run("inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId, lines: [
      // Lot A expires last and sits in A1; lot B expires first and sits in B1: FEFO takes B.
      { productId: lotProduct, locationId: l1, qty: 4, unitCost: 100, lot: { code: "A", expiresOn: `${year + 1}-12-01` } },
      { productId: lotProduct, locationId: l2, qty: 3, unitCost: 100, lot: { code: "B", expiresOn: `${year + 1}-06-01` } },
      // The untracked product: 10 in A1, 6 in B1 (one bucket per line, the one with most stock: A1).
      { productId: plainProduct, locationId: l1, qty: 10, unitCost: 50 },
      { productId: plainProduct, locationId: l2, qty: 6, unitCost: 50 },
      // Two serials in A1, one in B1.
      { productId: serialProduct, locationId: l1, qty: 2, unitCost: 900, serials: [{ serialNo: "S1" }, { serialNo: "S2" }] },
      { productId: serialProduct, locationId: l2, qty: 1, unitCost: 900, serials: [{ serialNo: "S3" }] },
    ] });
    expect(await drain()).toEqual([]);
    lot = Object.fromEntries((await sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${lotProduct}`).map((l) => [l.code, l.id]));
    serial = Object.fromEntries((await sql<{ id: string; serial_no: string }[]>`select id, serial_no from inventory.serials where product_id = ${serialProduct}`).map((s) => [s.serial_no, s.id]));
  }, 300_000);

  afterAll(async () => {
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["warehouse", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = ${companyId}`;
    });
    await sql`delete from kernel.document_links where company_id = ${companyId}`.catch(() => undefined);
    await sql`delete from kernel.audit_log where company_id = ${companyId}`.catch(() => undefined);
    await seed.cleanup();
    await sql.end();
  });

  let first: { id: string; lineIds: string[] };
  let firstPick: PickRow;
  let firstDelivery: DeliveryRow;
  let picked: Bucket[];

  it("(1) a confirmed alistamiento leaves one open entrega with the picked lots and serials, linked to the alistamiento and the pedido; with delivery_from_pick off none", async () => {
    first = await confirmedOrder([{ productId: lotProduct, qty: 3 }, { productId: plainProduct, qty: 4 }, { productId: serialProduct, qty: 2 }]);
    firstPick = await pickOf(first.id);
    const lines = await pickLines(firstPick.id);
    const lineOf = (orderLineId: string) => lines.find((l) => l.order_line_id === orderLineId)!;
    // The picker takes what FEFO and «most stock» would not: lot A from A1 (FEFO says B), the plain product from B1 (most stock: A1), and
    // serials S1 (A1) and S3 (B1).
    await run("warehouse.pick.confirm", {
      id: firstPick.id,
      lines: [
        ...lines.filter((l) => l.order_line_id === first.lineIds[0]).map((l, i) => ({ pickLineId: l.id, locationId: l1, lotId: lot.A, qtyPicked: i === 0 ? 3 : 0 })),
        { pickLineId: lineOf(first.lineIds[1]!).id, locationId: l2, qtyPicked: 4 },
        { pickLineId: lineOf(first.lineIds[2]!).id, locationId: l1, serialId: serial.S1, qtyPicked: 1 },
        { pickLineId: lineOf(first.lineIds[2]!).id, locationId: l2, serialId: serial.S3, qtyPicked: 1 },
      ],
    });
    expect(await drain()).toEqual([]);
    picked = await allocations(first.lineIds);
    expect(picked).toEqual(sortBuckets([
      [lotProduct, l1, lot.A!, null, 3],
      [plainProduct, l2, null, null, 4],
      [serialProduct, l1, null, serial.S1!, 1],
      [serialProduct, l2, null, serial.S3!, 1],
    ]));

    const deliveries = await deliveriesOf(first.id);
    expect(deliveries).toHaveLength(1);
    firstDelivery = deliveries[0]!;
    // Open (not shipped) and Grabada with its ENT- number, as a manual one: the user ships it.
    expect(firstDelivery).toMatchObject({ status: "saved", stage: "open" });
    expect(firstDelivery.number).toMatch(/^ENT-/);
    const dl = await deliveryLines(firstDelivery.id);
    expect(dl.map((l) => [l.order_line_id, Number(l.qty), l.lot_id, l.serial_ids ? [...l.serial_ids].sort() : null])).toEqual([
      [first.lineIds[0], 3, lot.A, null],
      [first.lineIds[1], 4, null, null],
      [first.lineIds[2], 2, null, [serial.S1, serial.S3].sort()],
    ]);
    expect((await linksInto(firstDelivery.id)).map((l) => [l.kind, l.from_entity, l.from_id])).toEqual([
      ["order_to_delivery", "sales.order", first.id],
      ["pick_to_delivery", "warehouse.pick", firstPick.id],
    ]);
    // The create ran from inventory's answer (origin event, sales.delivery.create), on the alistamiento's chain.
    const [allocatedRow] = await outbox("inventory.reservation.allocated", "pickId", firstPick.id);
    const audit = await sql<{ origin: string; process_id: string; chain_id: string }[]>`
      select origin, process_id, chain_id from kernel.audit_log where company_id = ${companyId} and row_id = ${firstDelivery.id} and action = 'insert'`;
    expect(audit.length).toBeGreaterThan(0);
    expect(new Set(audit.map((r) => `${r.origin}|${r.process_id}|${r.chain_id}`))).toEqual(new Set([`event|sales.delivery.create|${allocatedRow!.chain_id}`]));

    // A redelivered answer creates nothing more.
    const [allocated] = await outbox("inventory.reservation.allocated", "pickId", firstPick.id);
    expect(allocated!.payload).toMatchObject({ status: "allocated", createDelivery: true });
    await redeliver(allocated!, "sales");
    expect(await deliveriesOf(first.id)).toHaveLength(1);
    // Only inventory's answer names the alistamiento: from the screen or the assistant the input is refused.
    const fromUi = await run("sales.delivery.create", { orderId: first.id, pickId: randomUUID() }).then(() => null, (e: unknown) => e as Error);
    expect(fromUi?.message).toContain("pick_event_only");

    // delivery_from_pick off: the alistamiento is allocated and no entrega is made.
    await runStepUp("warehouse.settings.update", { deliveryFromPick: false });
    const quiet = await confirmedOrder([{ productId: plainProduct, qty: 1 }]);
    const quietPick = await pickOf(quiet.id);
    await run("warehouse.pick.confirm", { id: quietPick.id });
    expect(await drain()).toEqual([]);
    expect(await pickOf(quiet.id)).toMatchObject({ stage: "confirmed", allocation_status: "allocated" });
    expect(await deliveriesOf(quiet.id)).toEqual([]);
    await run("sales.order.cancel", { id: quiet.id, reason: "Prueba" });
    expect(await drain()).toEqual([]);
    await runStepUp("warehouse.settings.update", { deliveryFromPick: true });
  });

  it("(2) Review Focus 3: the ship issues exactly the allocated ubicación, lot and serial; the allocations are used up with the reservation", async () => {
    await run("sales.delivery.ship", { id: firstDelivery.id });
    expect(await drain()).toEqual([]);
    expect(await issued(firstDelivery.id)).toEqual(picked);
    expect(await allocations(first.lineIds)).toEqual([]);
    // What the issue took is recorded on the entrega lines (Task 28.3).
    const lots = await sql<{ lot_id: string | null; serial_id: string | null; qty: string }[]>`
      select ll.lot_id, ll.serial_id, ll.qty::text from sales.delivery_line_lots ll join sales.delivery_lines l on l.id = ll.delivery_line_id
      where l.delivery_id = ${firstDelivery.id} order by ll.lot_id nulls last, ll.serial_id`;
    expect(lots.map((l) => [l.lot_id, l.serial_id, Number(l.qty)])).toEqual(
      [[lot.A, null, 3], ...[serial.S1, serial.S3].sort().map((s) => [null, s, 1])],
    );
    expect(await onHand(lotProduct, l1, lot.A)).toBe(1);
    expect(await onHand(lotProduct, l2, lot.B)).toBe(3);
    expect(await onHand(plainProduct, l1)).toBe(10);
    expect(await onHand(plainProduct, l2)).toBe(2);
  });

  it("(3) a manual entrega of a pedido without an alistamiento ships by FEFO as in 28.3", async () => {
    await runStepUp("warehouse.settings.update", { autoPickOnConfirm: false });
    const order = await confirmedOrder([{ productId: lotProduct, qty: 2 }]);
    expect(await sql`select 1 from warehouse.picks where order_id = ${order.id}`).toHaveLength(0);
    const delivery = await run<{ id: string }>("sales.delivery.create", { orderId: order.id });
    await run("sales.delivery.ship", { id: delivery.id });
    expect(await drain()).toEqual([]);
    expect(await issued(delivery.id)).toEqual([[lotProduct, l2, lot.B, null, 2]]);
    await runStepUp("warehouse.settings.update", { autoPickOnConfirm: true });
  });

  it("(4) a short allocation creates no entrega", async () => {
    // B1 holds 2 of the plain product; the picker says 8 came from there.
    const order = await confirmedOrder([{ productId: plainProduct, qty: 8 }]);
    const pick = await pickOf(order.id);
    const lines = await pickLines(pick.id);
    await run("warehouse.pick.confirm", { id: pick.id, lines: lines.map((l, i) => ({ pickLineId: l.id, locationId: l2, qtyPicked: i === 0 ? 8 : 0 })) });
    expect(await drain()).toEqual([]);
    const [allocated] = await outbox("inventory.reservation.allocated", "pickId", pick.id);
    expect(allocated!.payload).toMatchObject({ status: "short" });
    expect(await pickOf(order.id)).toMatchObject({ stage: "in_progress", allocation_status: "short" });
    expect(await deliveriesOf(order.id)).toEqual([]);
    await run("sales.order.cancel", { id: order.id, reason: "Prueba" });
    expect(await drain()).toEqual([]);
  });

  it("(5) voiding the entrega gives the stock back to the allocated buckets and Task 43's re-reservation keeps working", async () => {
    await run("sales.delivery.void", { id: firstDelivery.id, reason: "El cliente no recibió", reReserve: true });
    expect(await drain()).toEqual([]);
    expect(await onHand(lotProduct, l1, lot.A)).toBe(4);
    expect(await onHand(plainProduct, l2)).toBe(6);
    expect(await onHand(serialProduct, l1, null, serial.S1)).toBe(1);
    expect(await onHand(serialProduct, l2, null, serial.S3)).toBe(1);
    const [voided] = await sql<{ re_reserve_result: string | null }[]>`select re_reserve_result from sales.deliveries where id = ${firstDelivery.id}`;
    expect(voided!.re_reserve_result).toBe("reserved");
    const reserved = await sql<{ source_line_id: string; open: string }[]>`
      select source_line_id, (qty - released_qty)::text as open from inventory.reservations
      where source_line_id = any(${first.lineIds}::uuid[]) and status = 'active' order by source_line_id`;
    expect(reserved.map((r) => [r.source_line_id, Number(r.open)])).toEqual(
      [[first.lineIds[0], 3], [first.lineIds[1], 4], [first.lineIds[2], 2]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // The pick-to-entrega link is kept, marked voided with the entrega (Task 31).
    const [link] = await sql<{ voided_at: Date | null }[]>`
      select voided_at from kernel.document_links where company_id = ${companyId} and kind = 'pick_to_delivery' and to_id = ${firstDelivery.id}`;
    expect(link!.voided_at).not.toBeNull();
  });

  it("(5b) a partial ship uses up only its part of the allocation; the rest ships from the allocation later", async () => {
    // The picker takes 5 of the plain product from B1 (6 there): the entrega from the alistamiento is cut to 3 before shipping.
    const order = await confirmedOrder([{ productId: plainProduct, qty: 5 }]);
    const pick = await pickOf(order.id);
    const lines = await pickLines(pick.id);
    await run("warehouse.pick.confirm", { id: pick.id, lines: lines.map((l, i) => ({ pickLineId: l.id, locationId: l2, qtyPicked: i === 0 ? 5 : 0 })) });
    expect(await drain()).toEqual([]);
    const [delivery] = await deliveriesOf(order.id);
    await run("sales.delivery.update", { id: delivery!.id, lines: [{ orderLineId: order.lineIds[0], qty: 3 }] });
    await run("sales.delivery.ship", { id: delivery!.id });
    expect(await drain()).toEqual([]);
    expect(await issued(delivery!.id)).toEqual([[plainProduct, l2, null, null, 3]]);
    expect(await allocations(order.lineIds)).toEqual([[plainProduct, l2, null, null, 2]]);
    // The rest, by hand: A1 has the most stock, the allocation says B1.
    const rest = await run<{ id: string }>("sales.delivery.create", { orderId: order.id });
    await run("sales.delivery.ship", { id: rest.id });
    expect(await drain()).toEqual([]);
    expect(await issued(rest.id)).toEqual([[plainProduct, l2, null, null, 2]]);
    expect(await allocations(order.lineIds)).toEqual([]);
  });
});
