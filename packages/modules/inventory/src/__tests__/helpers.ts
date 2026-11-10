import { randomUUID } from "node:crypto";
import { buildConsumerContext, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ConsumerContext, type RunProcessDeps } from "@erp/kernel";
import { needStub, seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { core } from "@erp/module-core";
import { inventory } from "../index";

export type Db = ReturnType<typeof testDb>;

const registry = new Registry();
loadModules(registry, [kernelModule, core, inventory, needStub("costing")]);

/** Every process of core and inventory as the loader registers them (the generic lifecycle ones included). */
const PROCESS_IDS = [...registry.processes({ module: "core" }), ...registry.processes({ module: "inventory" })].map((p) => p.id);

/** Every inventory table, children first. */
export const INVENTORY_TABLES = ["reservation_allocations", "product_tracking", "count_lines", "counts", "transfer_lines", "transfers", "reservations", "stock_levels", "movement_lines", "movements", "serials", "lots", "movement_numbers", "locations", "warehouses"];

export interface InventoryHarness {
  sql: Db;
  deps: RunProcessDeps;
  registry: Registry;
  seed: SeededTenant;
  /** Admin of company 0 (user `both`). */
  admin: Caller;
  /** A member (not the admin) of company 0 holding role `bodeguero`: inventory processes, and `core.product.standard_cost` hidden. */
  member: Caller;
  /** Admin of company 1. */
  other: Caller;
  companyId: string;
  otherCompanyId: string;
  run: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** The caller with a fresh step-up verification (one use) for the process it runs next. */
  stepUp: (caller: Caller) => Promise<Caller>;
  /** `runProcess` as `caller` with a fresh step-up verification. */
  runStepUp: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** An event consumer's context for company 0 (origin `event`, system user), as the outbox drain builds it. */
  consumer: (event?: string) => ConsumerContext;
  cleanup: () => Promise<void>;
}

/** Seeds two companies entitled to core and inventory, grants their admins every core and inventory process, registers the manifests. */
export async function inventoryHarness(): Promise<InventoryHarness> {
  const sql = testDb();
  registerCountryPack(co);
  // The usability gate and the reference check find the tables of the maestros through kernel.entity_tables (written by the sync).
  await syncModuleManifest(sql, core);
  await syncModuleManifest(sql, inventory);
  const seed = await seedTenant(sql, {
    companies: 2,
    users: [{ name: "contador", companies: [0], role: "member" }],
    entitlements: ["module:core", "module:inventory"],
  });
  for (const company of seed.companies) {
    for (const id of PROCESS_IDS) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
                values (${company.id}, ${company.adminRoleId}, ${id}) on conflict (company_id, role_id, process_id) do nothing`;
    }
  }
  const companyId = seed.companies[0]!.id;
  const [bodeguero] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'bodeguero', false) returning id`;
  await seed.holdRoles(seed.users.contador!, companyId, [bodeguero!.id]);
  for (const id of PROCESS_IDS.filter((p) => p.startsWith("inventory.") || p === "core.product.consult")) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${bodeguero!.id}, ${id}) on conflict do nothing`;
  }
  await sql`insert into kernel.field_permissions(company_id, role_id, entity, field, mode) values (${companyId}, ${bodeguero!.id}, 'core.product', 'standard_cost', 'hidden')`;
  const otherCompanyId = seed.companies[1]!.id;
  const companyIds = [companyId, otherCompanyId];
  const deps = { sql, registry };
  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const caller = (company: string): Caller => ({ claims: seed.claimsFor(seed.users.both, company) as JwtClaims, origin: "ui" });
  return {
    sql,
    deps,
    registry,
    seed,
    admin: caller(companyId),
    member: { claims: { ...seed.claimsFor(seed.users.contador!, companyId), role_ids: [bodeguero!.id] } as JwtClaims, origin: "ui" },
    other: caller(otherCompanyId),
    companyId,
    otherCompanyId,
    run: <T>(c: Caller, processId: string, input: unknown) => runProcess(deps, c, processId, input) as Promise<T>,
    stepUp,
    runStepUp: async <T>(c: Caller, processId: string, input: unknown) => runProcess(deps, await stepUp(c), processId, input) as Promise<T>,
    consumer: (event = "sales.delivery.shipped") => buildConsumerContext(sql, { id: randomUUID(), event, companyId, chainId: randomUUID(), createdAt: new Date() }, registry),
    async cleanup() {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        for (const table of INVENTORY_TABLES) await tx`delete from ${tx(`inventory.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        for (const table of ["price_list_items", "price_lists", "party_contacts", "products", "product_categories", "parties", "document_sequences", "entity_sequences"]) {
          await tx`delete from ${tx(`core.${table}`)} where company_id = any(${companyIds}::uuid[])`;
        }
      });
      await sql`delete from kernel.record_snapshots where company_id = any(${companyIds}::uuid[])`.catch(() => undefined);
      await sql`delete from kernel.field_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.process_permissions where company_id = any(${companyIds}::uuid[])`;
      await sql`delete from kernel.outbox where company_id = any(${companyIds}::uuid[])`;
      await seed.cleanup();
      await sql.end();
    },
  };
}

/** A stocked good (core.product.create input) with SKU `sku`. */
export const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku,
  description: `Café ${sku}`,
  kind: "good",
  idScheme: "999",
  uomCode: "94",
  ivaRate: "5",
  otherTaxes: [],
  listPrice: 28500,
  isFreeSample: false,
  standardCost: 16200,
  trackStock: true,
  ...overrides,
});

/** Creates a product in the caller's company and returns its id. */
export async function product(h: InventoryHarness, caller: Caller, sku: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const out = await h.run<{ id: string }>(caller, "core.product.create", good(sku, overrides));
  return out.id;
}

/** Creates a bodega (with one ubicación) in the caller's company. */
export async function warehouse(h: InventoryHarness, caller: Caller, code: string, options: { allowBackorders?: boolean } = {}): Promise<{ id: string; locationId: string }> {
  const { id } = await h.run<{ id: string }>(caller, "inventory.warehouse.create", { code, name: `Bodega ${code}`, allowBackorders: options.allowBackorders ?? false });
  const location = await h.run<{ id: string }>(caller, "inventory.location.create", { warehouseId: id, code: "A1", name: "Estante A1" });
  return { id, locationId: location.id };
}

/** On hand, reserved and available of a product in a bodega (summed over its ubicaciones), through the published view. */
export async function stockOf(h: InventoryHarness, productId: string, warehouseId: string): Promise<{ onHand: number; reserved: number; available: number }> {
  const [row] = await h.sql<{ on_hand: string | null; reserved: string | null; available: string | null }[]>`
    select sum(on_hand) as on_hand, sum(reserved) as reserved, sum(available) as available
    from inventory.v_stock where product_id = ${productId} and warehouse_id = ${warehouseId}`;
  return { onHand: Number(row?.on_hand ?? 0), reserved: Number(row?.reserved ?? 0), available: Number(row?.available ?? 0) };
}

/** Every stock row of a product (all bodegas), through the published view, with the kind of its ubicación. */
export async function stockRows(h: InventoryHarness, productId: string): Promise<{ warehouseId: string; locationId: string | null; kind: string | null; onHand: number }[]> {
  const rows = await h.sql<{ warehouse_id: string; location_id: string | null; location_kind: string | null; on_hand: string }[]>`
    select warehouse_id, location_id, location_kind, on_hand from inventory.v_stock where product_id = ${productId} and on_hand <> 0 order by warehouse_id, location_id`;
  return rows.map((r) => ({ warehouseId: r.warehouse_id, locationId: r.location_id, kind: r.location_kind, onHand: Number(r.on_hand) }));
}

export const newId = () => randomUUID();
