import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, enableModule, kernelModule, loadModules, moduleGate, registerCountryPack, Registry, runProcess, syncModuleManifest, withClaims, type Caller, type ProcessError } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { warehouse } from "../index";

// Picks and the reservation's allocation (plan 2B.2 Task 29.1, PG §4.1–§4.3 steps 1–3 and 7; RG-7, RG-10; migration 0170), with the real
// modules. A confirmed pedido becomes one alistamiento (ALI-) proposing, per line, the ubicación and lot by FEFO then by the most stock; a
// confirmed alistamiento becomes inventory's allocation of the pedido lines' reservations (inventory.reservation_allocations), never a
// movement (RG-7); a line over its bucket's free quantity sends it back to «En proceso» naming the line; a cancelled pedido voids its open
// alistamiento and its allocations go with the reservation. A company that never bought the module parks the confirmation
// `not_entitled:warehouse`; buying it replays the event and creates no alistamiento for a pedido confirmed before (RG-10). Every event is
// handed to its consumers as the dispatch workflow does (`drain`, with the dispatcher's module gate: a consumer of a module the tenant did
// not buy is not run and the row is dead-lettered under that module, dispatch.workflow.ts).

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
interface PickOut { id: string; number: string | null; status: string; stage: string; orderId: string; lines: { id: string; orderLineId: string; productId: string; qtyRequested: number; locationId: string | null; lotId: string | null; serialId: string | null; qtyPicked: number | null }[] }
interface CreateOut { created: boolean; reason?: string; pick?: PickOut }
interface PickRow { id: string; number: string | null; status: string; stage: string; allocation_status: string | null; allocation_note: string | null }

interface Company { id: string; admin: Caller; seed: SeededTenant; partyId: string; warehouseId: string }

describe("picks and the reservation's allocation (Task 29.1)", () => {
  const sql = testDb();
  let seed: SeededTenant;
  let bare: SeededTenant;
  let a: Company;
  let b: Company;
  let year: number;
  let l1: string;
  let l2: string;
  let lotProduct: string;
  let plainProduct: string;
  let lot: Record<string, string>;

  const run = <T = unknown>(caller: Caller, processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(company: Company, processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${company.admin.claims.sub}, ${company.id}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...company.admin, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (ProcessError & { details: unknown }) | null;
  const day = (month: number, d = 15) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  /**
   * Hands every undispatched event of the company to its consumers, as the dispatch workflow does: a consumer of a module the tenant never
   * bought is not run (kernel.* events and the "*" consumer of a module without posting are skipped), and the row then goes to
   * kernel.outbox_dead_letter with `not_entitled:<module>` and `parked_module` (dispatchOutboxRow / deadLetter).
   */
  const drain = async (companyId: string) => {
    const failures: { event: string; moduleId: string; message: string }[] = [];
    const failed = new Set<string>();
    for (let round = 0; round < 25; round++) {
      const rows = (await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and dispatched_at is null order by created_at, id`).filter((r) => !failed.has(r.id));
      if (rows.length === 0) return failures;
      for (const row of rows) {
        let ok = true;
        let unentitled: string | null = null;
        for (const consumer of consumers.for(row.event).filter((c) => LOADED.has(c.moduleId))) {
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          if ((await moduleGate(sql, companyId, consumer.moduleId)) === "not_purchased") {
            if (row.event.startsWith("kernel.")) continue;
            if (consumers.isWildcard(row.event, consumer.moduleId) && registry.module(consumer.moduleId).postingProvider === undefined) continue;
            unentitled ??= consumer.moduleId;
            continue;
          }
          try {
            await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
            await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
          } catch (error) {
            ok = false;
            failures.push({ event: row.event, moduleId: consumer.moduleId, message: error instanceof Error ? error.message : String(error) });
          }
        }
        if (!ok) failed.add(row.id);
        else if (unentitled !== null) {
          await sql`
            with moved as (delete from kernel.outbox where id = ${row.id} returning *)
            insert into kernel.outbox_dead_letter (id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, last_error, failed_at, delivered_modules, parked_module)
            select id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, ${`not_entitled:${unentitled}`}, now(),
                   coalesce((select array_agg(d.module_id) from kernel.outbox_deliveries d where d.outbox_id = moved.id), '{}'), ${unentitled}
            from moved`;
        } else await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id}`;
      }
    }
    throw new Error("drain did not settle");
  };
  const redeliver = async (companyId: string, row: OutboxRow, moduleId: string) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId)!;
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };
  const outbox = (companyId: string, event: string, key: string, value: string) =>
    sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>${key} = ${value} order by created_at`;

  const markReady = async (companyId: string, tenantId: string, id: string) => {
    for (const tag of ["RUT", "Cámara de Comercio"]) {
      await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
        values (${companyId}, 'core.party', ${id}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${tenantId}/${companyId}/core.party/${id}/${randomUUID()}.pdf`})`;
    }
  };
  const setUp = async (tenant: SeededTenant, nit: string): Promise<Company> => {
    const companyId = tenant.companies[0]!.id;
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${tenant.companies[0]!.adminRoleId}, ${id}) on conflict do nothing`;
    }
    const admin: Caller = { claims: tenant.claimsFor(tenant.users.both, companyId) as JwtClaims, origin: "ui" };
    const company: Company = { id: companyId, admin, seed: tenant, partyId: "", warehouseId: "" };
    await runStepUp(company, "accounting.chart.seed", {});
    const [fy] = await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`;
    await sql`update accounting.settings set ledger_starts_on = ${`${fy!.year}-01-01`} where company_id = ${companyId}`;
    company.partyId = (await run<{ id: string }>(admin, "core.party.create", customer(nit, `Distribuidora ${nit} S.A.S.`))).id;
    await markReady(companyId, tenant.tenantId, company.partyId);
    company.warehouseId = (await run<{ id: string }>(admin, "inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
    return company;
  };
  const confirmedOrder = async (company: Company, lines: { productId: string; qty: number }[]) => {
    const order = await run<{ id: string }>(company.admin, "sales.order.create", { partyId: company.partyId, issueDate: day(3, 1), warehouseId: company.warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
    await run(company.admin, "sales.order.confirm", { id: order.id });
    expect(await drain(company.id)).toEqual([]);
    const ids = await sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
    return { id: order.id, lineIds: ids.map((l) => l.id) };
  };
  const picksOf = (orderId: string) =>
    sql<PickRow[]>`select id, number, status, stage, allocation_status, allocation_note from warehouse.picks where order_id = ${orderId} order by seq`;
  const pickLines = (pickId: string) =>
    sql<{ id: string; order_line_id: string; product_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty_requested: string; qty_picked: string | null; short_qty: string | null }[]>`
      select id, order_line_id, product_id, location_id, lot_id, serial_id, qty_requested::text, qty_picked::text, short_qty::text from warehouse.pick_lines where pick_id = ${pickId} order by line_no`;
  const allocations = (orderLineIds: string[]) =>
    sql<{ order_line_id: string; location_id: string | null; lot_id: string | null; serial_id: string | null; qty: string }[]>`
      select r.source_line_id as order_line_id, a.location_id, a.lot_id, a.serial_id, a.qty::text
      from inventory.reservation_allocations a join inventory.reservations r on r.id = a.reservation_id
      where r.source_line_id = any(${orderLineIds}::uuid[]) order by r.source_line_id, a.qty desc, a.location_id`;
  const stockSnapshot = async (companyId: string) => ({
    levels: (await sql<{ k: string }[]>`select string_agg(product_id::text || ':' || coalesce(location_id::text, '') || ':' || coalesce(lot_id::text, '') || ':' || on_hand::text, ',' order by product_id, location_id, lot_id) as k from inventory.stock_levels where company_id = ${companyId}`)[0]!.k,
    movements: Number((await sql<{ n: string }[]>`select count(*)::text as n from inventory.movements where company_id = ${companyId}`)[0]!.n),
  });

  beforeAll(async () => {
    registerCountryPack(co);
    for (const m of [core, inventory, costing, sales, accounting, warehouse]) await syncModuleManifest(sql, m);
    seed = await seedTenant(sql, {
      companies: 2,
      users: [{ name: "vendedor", companies: [0], role: "member" }],
      entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:warehouse"],
    });
    // A tenant that never bought the warehouse module (RG-10).
    bare = await seedTenant(sql, { companies: 1, entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales"] });
    a = await setUp(seed, "860002964");
    b = await setUp(bare, "900123456");
    year = (await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${a.id}`)[0]!.year;
    l1 = (await run<{ id: string }>(a.admin, "inventory.location.create", { warehouseId: a.warehouseId, code: "A1", name: "Estante A1" })).id;
    l2 = (await run<{ id: string }>(a.admin, "inventory.location.create", { warehouseId: a.warehouseId, code: "B1", name: "Estante B1" })).id;
    lotProduct = (await run<{ id: string }>(a.admin, "core.product.create", good(`LOT-${randomUUID().slice(0, 8)}`))).id;
    plainProduct = (await run<{ id: string }>(a.admin, "core.product.create", good(`UNT-${randomUUID().slice(0, 8)}`))).id;
    await runStepUp(a, "inventory.product_tracking.set", { productId: lotProduct, tracking: "lot" });
    await run(a.admin, "inventory.movement.post", { kind: "receipt", date: day(1, 10), warehouseId: a.warehouseId, lines: [
      // Lot A expires last and sits in A1; lot B expires first and sits in B1: FEFO takes B, then A.
      { productId: lotProduct, locationId: l1, qty: 4, unitCost: 100, lot: { code: "A", expiresOn: `${year + 1}-12-01` } },
      { productId: lotProduct, locationId: l2, qty: 3, unitCost: 100, lot: { code: "B", expiresOn: `${year + 1}-06-01` } },
      // The untracked product: 10 in A1, 6 in B1 (most stock: A1).
      { productId: plainProduct, locationId: l1, qty: 10, unitCost: 50 },
      { productId: plainProduct, locationId: l2, qty: 6, unitCost: 50 },
    ] });
    expect(await drain(a.id)).toEqual([]);
    lot = Object.fromEntries((await sql<{ id: string; code: string }[]>`select id, code from inventory.lots where product_id = ${lotProduct}`).map((l) => [l.code, l.id]));
  }, 300_000);

  afterAll(async () => {
    const companyIds = [...seed.companies.map((c) => c.id), ...bare.companies.map((c) => c.id)];
    await sql.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      const tables = await tx<{ schema: string; name: string }[]>`
        select c.table_schema as schema, c.table_name as name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
        where c.table_schema = any(${["warehouse", "sales", "costing", "inventory", "accounting", "core"]}) and c.column_name = 'company_id'`;
      for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
    });
    await sql`delete from kernel.audit_log where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
    await seed.cleanup();
    await bare.cleanup();
    await sql.end();
  });

  let first: { id: string; lineIds: string[] };
  let firstPick: PickRow;

  it("(1) migration 0170: the warehouse tables have company RLS, row audit and seq; the first alistamiento of a company is ALI-1", async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean }[]>`
      select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'warehouse' and c.relname = any(${["picks", "pick_lines", "settings"]}) order by c.relname`;
    expect(rls).toEqual([{ relname: "pick_lines", relrowsecurity: true }, { relname: "picks", relrowsecurity: true }, { relname: "settings", relrowsecurity: true }]);
    const audited = await sql<{ table: string }[]>`
      select distinct c.relname as table from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'warehouse' and t.tgname like '%audit%' and c.relname = any(${["picks", "pick_lines", "settings"]}) order by 1`;
    expect(audited.map((r) => r.table)).toEqual(["pick_lines", "picks", "settings"]);

    first = await confirmedOrder(a, [{ productId: lotProduct, qty: 5 }, { productId: plainProduct, qty: 4 }]);
    firstPick = (await picksOf(first.id))[0]!;
    expect(firstPick).toMatchObject({ number: "ALI-1", status: "saved", stage: "open" });
    const [row] = await sql<{ seq: string; created_by: string | null }[]>`select seq::text, created_by from warehouse.picks where id = ${firstPick.id}`;
    expect(Number(row!.seq)).toBeGreaterThan(0);
    // The row audit wrote its insert, on the event's chain (origin event).
    expect(await sql`select 1 from kernel.audit_log where company_id = ${a.id} and row_id = ${firstPick.id} and action = 'insert' and origin = 'event'`).toHaveLength(1);
    // Another company of the same user sees none of it (company RLS).
    const otherClaims = seed.claimsFor(seed.users.both, seed.companies[1]!.id);
    expect(await withClaims(sql, otherClaims, (tx) => tx`select 1 from warehouse.v_picks where id = ${firstPick.id}`)).toHaveLength(0);
    expect(await withClaims(sql, a.admin.claims, (tx) => tx`select 1 from warehouse.v_picks where id = ${firstPick.id}`)).toHaveLength(1);
  });

  it("(2) a confirmed pedido makes one alistamiento by FEFO then by the most stock; a redelivered confirmation makes none; with auto_pick_on_confirm off none (the UI still can)", async () => {
    const lines = await pickLines(firstPick.id);
    expect(lines.map((l) => [l.order_line_id, l.product_id, l.location_id, l.lot_id, Number(l.qty_requested)])).toEqual([
      [first.lineIds[0], lotProduct, l2, lot.B, 3],
      [first.lineIds[0], lotProduct, l1, lot.A, 2],
      [first.lineIds[1], plainProduct, l1, null, 4],
    ]);
    const [confirmed] = await outbox(a.id, "sales.order.confirmed", "orderId", first.id);
    await redeliver(a.id, confirmed!, "warehouse");
    expect(await picksOf(first.id)).toHaveLength(1);
    // From the UI, an order with an open alistamiento answers it.
    const again = await run<CreateOut>(a.admin, "warehouse.pick.create", { orderId: first.id });
    expect(again).toMatchObject({ created: false, reason: "open_pick", pick: { id: firstPick.id } });

    await runStepUp(a, "warehouse.settings.update", { autoPickOnConfirm: false });
    const quiet = await confirmedOrder(a, [{ productId: plainProduct, qty: 1 }]);
    expect(await picksOf(quiet.id)).toHaveLength(0);
    const manual = await run<CreateOut>(a.admin, "warehouse.pick.create", { orderId: quiet.id });
    expect(manual).toMatchObject({ created: true, pick: { number: "ALI-2", stage: "open" } });
    await run(a.admin, "warehouse.pick.void", { id: manual.pick!.id, reason: "Prueba" });
    await run(a.admin, "sales.order.cancel", { id: quiet.id, reason: "Prueba" });
    expect(await drain(a.id)).toEqual([]);
    await runStepUp(a, "warehouse.settings.update", { autoPickOnConfirm: true });
  });

  it("(3) RG-7: confirming the alistamiento allocates the reservations exactly as picked, moving no stock; a redelivered warehouse.pick.confirmed allocates once", async () => {
    const before = await stockSnapshot(a.id);
    const started = await run<PickOut>(a.admin, "warehouse.pick.start", { id: firstPick.id });
    expect(started.stage).toBe("in_progress");
    const [picker] = await sql<{ picker_user_id: string }[]>`select picker_user_id from warehouse.picks where id = ${firstPick.id}`;
    expect(picker!.picker_user_id).toBe(seed.users.both);
    const done = await run<PickOut>(a.admin, "warehouse.pick.confirm", { id: firstPick.id });
    expect(done.stage).toBe("confirmed");
    expect(await drain(a.id)).toEqual([]);

    const [event] = await outbox(a.id, "warehouse.pick.confirmed", "pickId", firstPick.id);
    expect(event!.payload).toMatchObject({ pickId: firstPick.id, orderId: first.id, warehouseId: a.warehouseId, createDelivery: true });
    expect(event!.payload.lines).toHaveLength(3);
    const want = [
      [first.lineIds[0], l2, lot.B, null, 3],
      [first.lineIds[0], l1, lot.A, null, 2],
      [first.lineIds[1], l1, null, null, 4],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0])) || Number(y[4]) - Number(x[4]) || String(x[1]).localeCompare(String(y[1])));
    const got = (await allocations(first.lineIds)).map((r) => [r.order_line_id, r.location_id, r.lot_id, r.serial_id, Number(r.qty)]);
    expect(got).toEqual(want);
    // No movement, no stock change (RG-7).
    expect(await stockSnapshot(a.id)).toEqual(before);
    const [allocated] = await outbox(a.id, "inventory.reservation.allocated", "pickId", firstPick.id);
    expect(allocated!.payload).toMatchObject({ pickId: firstPick.id, orderId: first.id, createDelivery: true, status: "allocated", short: [] });
    expect((await picksOf(first.id))[0]).toMatchObject({ stage: "confirmed", allocation_status: "allocated" });

    // A redelivered confirmation allocates once and answers nothing new.
    await redeliver(a.id, event!, "inventory");
    expect((await allocations(first.lineIds)).map((r) => [r.order_line_id, r.location_id, r.lot_id, r.serial_id, Number(r.qty)])).toEqual(want);
    expect(await outbox(a.id, "inventory.reservation.allocated", "pickId", firstPick.id)).toHaveLength(1);
    expect(await stockSnapshot(a.id)).toEqual(before);
  });

  let third: { id: string; lineIds: string[] };

  it("(4) a line over its bucket's free quantity is short: nothing is allocated and the alistamiento goes back to «En proceso» naming the line", async () => {
    // A1 holds 10 of the plain product, 4 of them allocated to the first pedido: 6 free. This pedido asks 8 and the picker takes all 8 from A1.
    third = await confirmedOrder(a, [{ productId: plainProduct, qty: 8 }]);
    const [pick] = await picksOf(third.id);
    const lines = await pickLines(pick!.id);
    expect(lines.reduce((sum, l) => sum + Number(l.qty_requested), 0)).toBe(8);
    // More than requested is refused before anything happens.
    const over = await refusal(run(a.admin, "warehouse.pick.confirm", { id: pick!.id, lines: [{ pickLineId: lines[0]!.id, locationId: l1, qtyPicked: 9 }] }));
    expect(over?.message).toContain("pick_over_requested");
    await run(a.admin, "warehouse.pick.confirm", {
      id: pick!.id,
      lines: lines.map((l, i) => ({ pickLineId: l.id, locationId: l1, qtyPicked: i === 0 ? 8 : 0 })),
    });
    expect(await drain(a.id)).toEqual([]);
    const [allocated] = await outbox(a.id, "inventory.reservation.allocated", "pickId", pick!.id);
    expect(allocated!.payload).toMatchObject({ status: "short", short: [{ orderLineId: third.lineIds[0], productId: plainProduct, qty: 8, available: 6 }] });
    expect(await allocations(third.lineIds)).toEqual([]);
    const [after] = await picksOf(third.id);
    expect(after).toMatchObject({ stage: "in_progress", allocation_status: "short" });
    expect(after!.allocation_note).toContain("Línea 1");
    expect(Number((await pickLines(pick!.id))[0]!.short_qty)).toBe(2);
  });

  it("(5) a cancelled pedido voids its alistamiento; inventory's release drops the allocations with the reservation", async () => {
    expect(await allocations(first.lineIds)).toHaveLength(3);
    // Since Task 29.2 the allocated alistamiento left an open entrega (delivery_from_pick): a pedido with one is not cancelled, so it is
    // voided first (it never shipped: the allocations stay with the reservation).
    for (const d of await sql<{ id: string }[]>`select id from sales.deliveries where order_id = ${first.id} and status <> 'voided'`) {
      await run(a.admin, "sales.delivery.void", { id: d.id, reason: "El cliente desistió" });
    }
    expect(await allocations(first.lineIds)).toHaveLength(3);
    await run(a.admin, "sales.order.cancel", { id: first.id, reason: "El cliente desistió" });
    await run(a.admin, "sales.order.cancel", { id: third.id, reason: "El cliente desistió" });
    expect(await drain(a.id)).toEqual([]);
    expect((await picksOf(first.id))[0]).toMatchObject({ status: "voided" });
    expect((await picksOf(third.id))[0]).toMatchObject({ status: "voided" });
    expect(await allocations(first.lineIds)).toEqual([]);
    const [reserved] = await sql<{ n: string }[]>`select count(*)::text as n from inventory.reservations where source_line_id = any(${first.lineIds}::uuid[]) and status = 'active'`;
    expect(Number(reserved!.n)).toBe(0);
    // A voided alistamiento is not confirmed again.
    expect((await refusal(run(a.admin, "warehouse.pick.confirm", { id: firstPick.id })))?.message).toMatch(/pick_voided|invalid_state/);
  });

  it("(6) RG-10: without the module the confirmation is parked not_entitled:warehouse; buying it replays the event and makes no alistamiento for a pedido confirmed before", async () => {
    const productId = (await run<{ id: string }>(b.admin, "core.product.create", good(`B-${randomUUID().slice(0, 8)}`))).id;
    const order = await confirmedOrder(b, [{ productId, qty: 2 }]);
    const [parked] = await sql<{ id: string; parked_module: string; last_error: string }[]>`
      select id, parked_module, last_error from kernel.outbox_dead_letter where company_id = ${b.id} and event = 'sales.order.confirmed' and payload->>'orderId' = ${order.id}`;
    expect(parked).toMatchObject({ parked_module: "warehouse", last_error: "not_entitled:warehouse" });

    // The tenant buys the module and the company switches it on (its dependencies on too): the parked event goes back to the outbox once.
    await sql`insert into kernel.tenant_entitlements (tenant_id, key, source) values (${bare.tenantId}, 'module:warehouse', 'manual')`;
    for (const moduleId of ["core", "inventory"]) {
      await sql`insert into kernel.company_modules (company_id, module_id, enabled) values (${b.id}, ${moduleId}, true) on conflict (company_id, module_id) do nothing`;
    }
    await enableModule(sql, b.id, "warehouse", registry);
    expect(await sql`select 1 from kernel.outbox where id = ${parked!.id} and dispatched_at is null`).toHaveLength(1);
    expect(await drain(b.id)).toEqual([]);
    expect(await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${parked!.id} and module_id = 'warehouse'`).toHaveLength(1);
    expect(await sql`select 1 from warehouse.picks where company_id = ${b.id}`).toHaveLength(0);
    // The same answer from the event path, asked again: before_enabled.
    const [replayed] = await sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where id = ${parked!.id}`;
    const ctx = buildConsumerContext(sql, { id: randomUUID(), event: replayed!.event, createdAt: replayed!.created_at, companyId: b.id, chainId: replayed!.chain_id }, registry);
    expect(await ctx.runProcess("warehouse.pick.create", { orderId: order.id, eventId: randomUUID(), confirmedAt: (replayed!.payload.dates as { confirmedAt: string }).confirmedAt })).toMatchObject({ created: false, reason: "before_enabled" });
  });
});
