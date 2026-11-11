import { needStub } from "@erp/kernel/testing";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildConsumerContext, consumers, type Caller } from "@erp/kernel";
import { inventory } from "@erp/module-inventory";
import { accountingHarness, type AccountingHarness } from "./helpers";

// The 2A default rule `inventory-adjustment` over real inventory events (plan 2B Task 7). The rule carries a `when` (kind = adjustment and a
// non-zero value): a receipt, an issue or a transfer leg reaching it posts nothing and records no failure; an adjustment posts balanced
// on the demo chart (gain: Dr inventory / Cr adjustment; loss: the opposite), valued at the line's cost or the product's standard cost.

let h: AccountingHarness;
let year: number;
let warehouseId: string;
let otherWarehouseId: string;
let locationId: string;
let costed: string;
let uncosted: string;
let costCenterId: string;

const run = <T = unknown>(processId: string, input: unknown, caller: Caller = h.admin) => h.run<T>(caller, processId, input);
const date = () => `${year}-03-15`;

beforeAll(async () => {
  h = await accountingHarness({ extraModules: [inventory, needStub("costing")] });
  const ids = [...h.deps.registry.processes({ module: "core" }), ...h.deps.registry.processes({ module: "inventory" })].map((p) => p.id);
  await h.grantAll(h.companyId, h.seed.companies[0]!.adminRoleId, ids);
  await h.runStepUp(h.admin, "accounting.chart.seed", {});
  year = (await h.sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${h.companyId}`)[0]!.year;
  await h.sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${h.companyId}`;

  // The demo chart's adjustment account (519595 · Otros) requires a cost center.
  costCenterId = (await h.sql<{ id: string }[]>`insert into accounting.cost_centers (company_id, code, name, kind) values (${h.companyId}, 'ADM', 'Administración', 'leaf') returning id`)[0]!.id;
  const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
    sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, ...overrides,
  });
  costed = (await run<{ id: string }>("core.product.create", good("ADJ-1", { standardCost: 7000 }))).id;
  uncosted = (await run<{ id: string }>("core.product.create", good("ADJ-2"))).id;
  const make = async (code: string) => {
    const { id } = await run<{ id: string }>("inventory.warehouse.create", { code, name: `Bodega ${code}` });
    const location = await run<{ id: string }>("inventory.location.create", { warehouseId: id, code: "A1", name: "Estante A1" });
    return { id, locationId: location.id };
  };
  ({ id: warehouseId, locationId } = await make("ADJW"));
  ({ id: otherWarehouseId } = await make("ADJX"));
}, 180_000);

afterAll(async () => {
  const companyIds = [h.companyId];
  await h.sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    for (const table of ["count_lines", "counts", "transfer_lines", "transfers", "reservations", "stock_levels", "movement_lines", "movements", "movement_numbers", "locations", "warehouses"]) {
      await tx`delete from ${tx(`inventory.${table}`)} where company_id = any(${companyIds}::uuid[])`;
    }
  });
  await h.cleanup();
});

/** Delivers every `inventory.movement.posted` event of the movement to the accounting consumer, as the dispatch workflow does. */
const deliver = async (movementId: string) => {
  const rows = await h.sql<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox
    where company_id = ${h.companyId} and event = 'inventory.movement.posted' and payload->>'movementId' = ${movementId}`;
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  const ctx = buildConsumerContext(h.sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: h.companyId, chainId: row.chain_id }, h.deps.registry);
  await consumers.for(row.event).find((c) => c.moduleId === "accounting")!.fn(ctx, row.payload);
  return row.id;
};
const entriesOf = (eventId: string) => h.sql<{ id: string; status: string; total_debit: string; total_credit: string; source_entity: string }[]>`
  select id, status, total_debit, total_credit, source_entity from accounting.entries where company_id = ${h.companyId} and source_event_id = ${eventId}`;
const failuresOf = (eventId: string) => h.sql`select error_code, error_detail from accounting.posting_failures where company_id = ${h.companyId} and event_id = ${eventId}`;
const linesOf = (entryId: string) => h.sql<{ code: string; debit: string; credit: string }[]>`
  select a.code, l.debit, l.credit from accounting.entry_lines l join accounting.accounts a on a.id = l.account_id where l.entry_id = ${entryId} order by l.line_no`;
const roleCode = async (role: string) =>
  (await h.sql<{ code: string }[]>`
    select a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${h.companyId} and m.role = ${role} and m.dimension is null`)[0]!.code;

describe("rule inventory-adjustment over inventory events", () => {
  it("the company has the rule, with its kind condition", async () => {
    const [rule] = await h.sql<{ template: { when: unknown } }[]>`select template from accounting.posting_rules where company_id = ${h.companyId} and event = 'inventory.movement.posted'`;
    expect(rule!.template.when).toEqual([{ path: "$.kind", equals: "adjustment" }, { path: "$.value", notEquals: 0 }]);
  });

  // Migration 0071 brings the copies of the default rule seeded before `when` existed in line, and only the unmodified ones.
  it("migration 0071 patches an unmodified old copy of the rule, leaves a modified one alone and is a no-op the second time", async () => {
    const migration = readFileSync(new URL("../../../../../supabase/migrations/0071_accounting_inventory_rule_when.sql", import.meta.url), "utf8");
    const oldTemplate = (await h.sql<{ template: Record<string, unknown> }[]>`
      select template from accounting.posting_rules where company_id = ${h.companyId} and event = 'inventory.movement.posted'`)[0]!.template;
    delete oldTemplate.when;
    const rule = async () => (await h.sql<{ template: { when?: unknown }; updated_at: Date }[]>`
      select template, updated_at from accounting.posting_rules where company_id = ${h.companyId} and event = 'inventory.movement.posted'`)[0]!;
    const seed = (modified: boolean) => h.sql`
      update accounting.posting_rules set template = ${h.sql.json(oldTemplate as never)}, is_modified = ${modified}
      where company_id = ${h.companyId} and event = 'inventory.movement.posted'`;
    const apply = async () => (await h.sql.unsafe(migration)).count;

    await seed(true);
    await apply();
    expect((await rule()).template.when).toBeUndefined();

    await seed(false);
    expect((await rule()).template.when).toBeUndefined();
    expect(await apply()).toBe(1);
    const patched = await rule();
    expect(patched.template.when).toEqual([{ path: "$.kind", equals: "adjustment" }, { path: "$.value", notEquals: 0 }]);
    expect(await apply()).toBe(0);
    expect((await rule()).updated_at).toEqual(patched.updated_at);
  });

  it("a receipt, an issue and the legs of a traslado record no posting failure and post nothing", async () => {
    const movements: string[] = [];
    const post = async (kind: string, qty: number) =>
      (await run<{ id: string }>("inventory.movement.post", { kind, date: date(), warehouseId, lines: [{ productId: costed, locationId, qty, unitCost: 7000 }] })).id;
    movements.push(await post("receipt", 20), await post("issue", -2));
    const transfer = await run<{ id: string }>("inventory.transfer.create", { date: date(), fromWarehouseId: warehouseId, toWarehouseId: otherWarehouseId, lines: [{ productId: costed, fromLocationId: locationId, qty: 3 }] });
    const shipped = await run<{ movements: string[] }>("inventory.transfer.ship", { id: transfer.id });
    await run("inventory.transfer.receive", { id: transfer.id });
    const legs = await h.sql<{ id: string }[]>`select id from inventory.movements where source_id = ${transfer.id}`;
    expect(legs).toHaveLength(4);
    expect(shipped.movements).toHaveLength(2);
    movements.push(...legs.map((l) => l.id));
    for (const movementId of movements) {
      const eventId = await deliver(movementId);
      expect(await failuresOf(eventId)).toEqual([]);
      expect(await entriesOf(eventId)).toEqual([]);
    }
  });

  it("a gain posts a balanced entry on the demo chart: Dr inventory, Cr inventory adjustment, at the standard cost", async () => {
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", {
      date: date(), warehouseId, reason: "Sobrante en inventario", costCenterId, lines: [{ productId: costed, locationId, qty: 10 }],
    });
    const eventId = await deliver(adjustment.id);
    expect(await failuresOf(eventId)).toEqual([]);
    const [entry] = await entriesOf(eventId);
    expect(entry).toMatchObject({ status: "posted", total_debit: "70000.0000", total_credit: "70000.0000", source_entity: "inventory.movement" });
    const inventoryCode = await roleCode("inventory");
    const adjustmentCode = await roleCode("inventory_adjustment");
    expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      [inventoryCode, "70000.0000", "0.0000"],
      [adjustmentCode, "0.0000", "70000.0000"],
    ]);
  });

  it("a loss posts the opposite sides, valued at the line's own cost", async () => {
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", {
      date: date(), warehouseId, reason: "Merma por humedad", costCenterId, lines: [{ productId: costed, locationId, qty: -4, unitCost: 8000 }],
    });
    const eventId = await deliver(adjustment.id);
    expect(await failuresOf(eventId)).toEqual([]);
    const [entry] = await entriesOf(eventId);
    expect(entry).toMatchObject({ status: "posted", total_debit: "32000.0000", total_credit: "32000.0000" });
    const inventoryCode = await roleCode("inventory");
    const adjustmentCode = await roleCode("inventory_adjustment");
    expect((await linesOf(entry!.id)).map((l) => [l.code, l.debit, l.credit])).toEqual([
      [inventoryCode, "0.0000", "32000.0000"],
      [adjustmentCode, "32000.0000", "0.0000"],
    ]);
  });

  it("an adjustment of a product without cost moves the stock and posts nothing (no failure)", async () => {
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", {
      date: date(), warehouseId, reason: "Producto sin costo", lines: [{ productId: uncosted, locationId, qty: 5 }],
    });
    const eventId = await deliver(adjustment.id);
    expect(await failuresOf(eventId)).toEqual([]);
    expect(await entriesOf(eventId)).toEqual([]);
  });

  it("one adjustment with a gain and a loss posts both, balanced, each on its own side", async () => {
    const other = (await run<{ id: string }>("core.product.create", {
      sku: "ADJ-3", description: "Café ADJ-3", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 1, isFreeSample: false, trackStock: true, standardCost: 1000,
    })).id;
    await run("inventory.movement.post", { kind: "receipt", date: date(), warehouseId, lines: [{ productId: other, locationId, qty: 10 }] });
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", {
      date: date(), warehouseId, reason: "Gana uno, pierde otro", costCenterId,
      lines: [{ productId: costed, locationId, qty: 2 }, { productId: other, locationId, qty: -4 }],
    });
    const eventId = await deliver(adjustment.id);
    expect(await failuresOf(eventId)).toEqual([]);
    const [entry] = await entriesOf(eventId);
    expect(entry).toMatchObject({ status: "posted", total_debit: "18000.0000", total_credit: "18000.0000" });
    const inv = await roleCode("inventory");
    const adj = await roleCode("inventory_adjustment");
    const lines = (await linesOf(entry!.id)).map((l) => `${l.code}|${l.debit}|${l.credit}`).sort();
    expect(lines).toEqual([
      `${inv}|0.0000|4000.0000`, `${inv}|14000.0000|0.0000`, `${adj}|0.0000|14000.0000`, `${adj}|4000.0000|0.0000`,
    ].sort());
  });

  it("without a cost center the account that requires one records a missing_cost_center failure, to resolve in the failures page", async () => {
    const adjustment = await h.runStepUp<{ id: string }>(h.admin, "inventory.adjustment.post", {
      date: date(), warehouseId, reason: "Sin centro de costo", lines: [{ productId: costed, locationId, qty: 1 }],
    });
    const eventId = await deliver(adjustment.id);
    expect(await failuresOf(eventId)).toEqual([expect.objectContaining({ error_code: "missing_cost_center" })]);
    expect(await entriesOf(eventId)).toEqual([]);
  });

  it("a count's adjustment posts through the engine too, with the sign of the difference", async () => {
    const count = await run<{ id: string; lines: { id: string }[] }>("inventory.count.create", { date: date(), warehouseId, lines: [{ productId: costed, locationId }] });
    const [held] = await h.sql<{ on_hand: string }[]>`select on_hand from inventory.stock_levels where product_id = ${costed} and location_id = ${locationId}`;
    await run("inventory.count.record", { id: count.id, lines: [{ lineId: count.lines[0]!.id, countedQty: Number(held!.on_hand) - 2 }] });
    const applied = await h.runStepUp<{ adjustmentId: string }>(h.admin, "inventory.count.apply", { id: count.id, costCenterId });
    const eventId = await deliver(applied.adjustmentId);
    expect(await failuresOf(eventId)).toEqual([]);
    const [entry] = await entriesOf(eventId);
    expect(entry).toMatchObject({ status: "posted", total_debit: "14000.0000", total_credit: "14000.0000" });
  });
});
