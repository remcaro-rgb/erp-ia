import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCountryPack, Registry, runProcess, syncModuleManifest, type Caller, type ModuleDef, type RunProcessDeps } from "@erp/kernel";
import { seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { inventory } from "@erp/module-inventory";
import { costing } from "../index";

export type Db = ReturnType<typeof testDb>;

export interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }

export interface CostingHarness {
  sql: Db;
  deps: RunProcessDeps;
  registry: Registry;
  seed: SeededTenant;
  /** Admin of company 0 (user `both`). */
  admin: Caller;
  /** A member of company 0 who holds ONLY the landed cost processes of costing (no accounting grants, no inventory or core processes). */
  clerk: Caller;
  companyId: string;
  otherCompanyId: string;
  run: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  runStepUp: <T = unknown>(caller: Caller, processId: string, input: unknown) => Promise<T>;
  /** The `inventory.movement.posted` outbox row of a movement. */
  movementEvent: (movementId: string) => Promise<OutboxRow>;
  /** Hands an outbox row to `moduleId`'s consumer of its event, as the dispatch workflow does (origin event, the row's chain). */
  deliver: (row: OutboxRow, moduleId: string) => Promise<void>;
  /** The `costing.cogs.posted` rows of a movement. */
  cogsEvents: (movementId: string) => Promise<OutboxRow[]>;
  cleanup: () => Promise<void>;
}

/** Module schemas a harness company leaves rows in (children first does not matter: replica role, no triggers or FK checks). */
const SCHEMAS = ["costing", "inventory", "accounting", "core"];

/**
 * Seeds two companies entitled to core, inventory and costing (and accounting when asked), registers the manifests, and grants their
 * admins every process of the loaded modules (the system user of the event consumers holds the admin role).
 */
export async function costingHarness(options: { accounting?: boolean } = {}): Promise<CostingHarness> {
  const sql = testDb();
  const modules: ModuleDef[] = [kernelModule, core, ...(options.accounting ? [accounting] : []), inventory, costing];
  const registry = new Registry();
  loadModules(registry, modules);
  registerCountryPack(co);
  for (const m of [core, inventory, costing]) await syncModuleManifest(sql, m);
  const seed = await seedTenant(sql, {
    companies: 2,
    users: [{ name: "clerk", companies: [0], role: "member" }],
    entitlements: ["module:core", "module:inventory", "module:costing", ...(options.accounting ? ["module:accounting"] : [])],
  });
  const ids = modules.filter((m) => m.id !== "kernel").flatMap((m) => registry.processes({ module: m.id })).map((p) => p.id);
  for (const company of seed.companies) {
    for (const id of ids) {
      await sql`insert into kernel.process_permissions(company_id, role_id, process_id)
                values (${company.id}, ${company.adminRoleId}, ${id}) on conflict (company_id, role_id, process_id) do nothing`;
    }
  }
  const companyId = seed.companies[0]!.id;
  const [clerkRole] = await sql<{ id: string }[]>`insert into kernel.roles(company_id, name, is_system) values (${companyId}, 'clerk', false) returning id`;
  await seed.holdRoles(seed.users.clerk!, companyId, [clerkRole!.id]);
  for (const id of ["costing.landed_cost.allocate", "costing.landed_cost.void", "costing.landed_cost.consult"]) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${clerkRole!.id}, ${id})`;
  }
  const otherCompanyId = seed.companies[1]!.id;
  const companyIds = [companyId, otherCompanyId];
  const deps = { sql, registry };
  const stepUp = async (caller: Caller): Promise<Caller> => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${caller.claims.sub}, ${caller.claims.active_company_id}, ${stepUpToken})`;
    return { ...caller, stepUpToken };
  };
  const run = <T>(c: Caller, processId: string, input: unknown) => runProcess(deps, c, processId, input) as Promise<T>;
  return {
    sql,
    deps,
    registry,
    seed,
    admin: { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" },
    clerk: { claims: { ...seed.claimsFor(seed.users.clerk!, companyId), role_ids: [clerkRole!.id] } as JwtClaims, origin: "ui" },
    companyId,
    otherCompanyId,
    run,
    runStepUp: async <T>(c: Caller, processId: string, input: unknown) => runProcess(deps, await stepUp(c), processId, input) as Promise<T>,
    async movementEvent(movementId) {
      const rows = await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox
        where event = 'inventory.movement.posted' and payload->>'movementId' = ${movementId}`;
      if (rows.length !== 1) throw new Error(`expected one movement event for ${movementId}, found ${rows.length}`);
      return rows[0]!;
    },
    async deliver(row, moduleId) {
      const [company] = await sql<{ company_id: string }[]>`select company_id from kernel.outbox where id = ${row.id}`;
      const ctx = buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: company!.company_id, chainId: row.chain_id }, registry);
      const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId);
      if (!consumer) throw new Error(`${moduleId} has no consumer of ${row.event}`);
      await consumer.fn(ctx, row.payload);
    },
    cogsEvents: (movementId) => sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox
      where event = 'costing.cogs.posted' and payload->>'movementId' = ${movementId} order by created_at`,
    async cleanup() {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        const tables = await tx<{ schema: string; name: string }[]>`
          select c.table_schema as schema, c.table_name as name from information_schema.columns c
          join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
          where c.table_schema = any(${SCHEMAS}) and c.column_name = 'company_id'`;
        for (const t of tables) await tx`delete from ${tx(`${t.schema}.${t.name}`)} where company_id = any(${companyIds}::uuid[])`;
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

/** A stocked good (core.product.create input) with SKU `sku`, without a standard cost unless given. */
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
  trackStock: true,
  ...overrides,
});

/** Creates a bodega with one ubicación in the admin's company. */
export async function warehouse(h: CostingHarness, code: string, options: { allowBackorders?: boolean } = {}): Promise<{ id: string; locationId: string }> {
  const { id } = await h.run<{ id: string }>(h.admin, "inventory.warehouse.create", { code, name: `Bodega ${code}`, allowBackorders: options.allowBackorders ?? false });
  const location = await h.run<{ id: string }>(h.admin, "inventory.location.create", { warehouseId: id, code: "A1", name: "Estante A1" });
  return { id, locationId: location.id };
}

/** The average layer of a product in a bodega, as numbers (null when costing has none). */
export async function layerOf(h: CostingHarness, productId: string, warehouseId: string): Promise<{ qty: number; value: number; avgCost: number | null } | null> {
  const [row] = await h.sql<{ qty: string; value: string; avg_cost: string | null }[]>`
    select qty, value, avg_cost from costing.cost_layers where company_id = ${h.companyId} and product_id = ${productId} and warehouse_id = ${warehouseId} and method = 'average'`;
  return row ? { qty: Number(row.qty), value: Number(row.value), avgCost: row.avg_cost === null ? null : Number(row.avg_cost) } : null;
}

/** The cost events of a movement, as numbers, in line order. */
export async function eventsOf(h: CostingHarness, movementId: string) {
  const rows = await h.sql<{ kind: string; qty: string; unit_cost: string; amount: string; cost_source: string; cost_missing: boolean; cogs_posted_at: Date | null; movement_seq: string }[]>`
    select e.kind, e.qty, e.unit_cost, e.amount, e.cost_source, e.cost_missing, e.cogs_posted_at, e.movement_seq
    from costing.cost_events e join inventory.movement_lines l on l.id = e.movement_line_id
    where e.company_id = ${h.companyId} and e.movement_id = ${movementId} order by l.line_no`;
  return rows.map((r) => ({ kind: r.kind, qty: Number(r.qty), unitCost: Number(r.unit_cost), amount: Number(r.amount), source: r.cost_source, missing: r.cost_missing, cogsPosted: r.cogs_posted_at !== null }));
}
