import { randomUUID } from "node:crypto";
import { buildConsumerContext, consumers, kernelModule, loadModules, moduleGate, registerCountryPack, Registry, runProcess, setExportsStore, syncModuleManifest, type Caller, type ProcessError } from "@erp/kernel";
import { MemoryFileStore, seedTenant, testDb, type JwtClaims, type SeededTenant } from "@erp/kernel/testing";
import { co } from "@erp/loc-co";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { inventory } from "@erp/module-inventory";
import { sales } from "@erp/module-sales";
import { expect } from "vitest";
import { warehouse } from "../index";

// The shared fixture of the packing and put-away tests (plan 2B.2 Task 29.3): the real modules, one tenant entitled to the warehouse
// module with one company (its chart seeded, a customer ready to invoice, the bodega PRI), and the dispatcher's drain with its module gate
// (as pick.integration.test.ts does: a consumer of a module the tenant did not buy is not run and the row is dead-lettered under it).

export const registry = new Registry();
const MODULES = [kernelModule, core, accounting, inventory, costing, sales, warehouse];
loadModules(registry, MODULES);
const PROCESS_IDS = [
  ...["core", "accounting", "inventory", "costing", "sales", "warehouse"].flatMap((m) => registry.processes({ module: m })).map((p) => p.id),
  "kernel.doc_template.print",
];
const LOADED = new Set(MODULES.map((m) => m.id));

export const good = (sku: string, overrides: Record<string, unknown> = {}) => ({
  sku, description: `Café ${sku}`, kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 28500, isFreeSample: false, trackStock: true, ...overrides,
});
const customer = (documentNumber: string, legalName: string) => ({
  kind: ["customer"], personType: "1", documentType: "31", documentNumber, legalName, taxResponsibilities: ["O-13"], taxScheme: "01",
  countryCode: "CO", departmentCode: "11", municipalityCode: "11001", addressLine: "Cra 1 # 2-3", invoiceEmail: "fe@cliente.example",
});

export interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }
export type Refusal = (ProcessError & { details: unknown }) | null;

export interface Harness {
  sql: ReturnType<typeof testDb>;
  seed: SeededTenant;
  companyId: string;
  admin: Caller;
  partyId: string;
  warehouseId: string;
  year: number;
  exportsStore: MemoryFileStore;
  run: <T = unknown>(processId: string, input: unknown, caller?: Caller) => Promise<T>;
  runStepUp: <T = unknown>(processId: string, input: unknown) => Promise<T>;
  refusal: (promise: Promise<unknown>) => Promise<Refusal>;
  drain: () => Promise<{ event: string; moduleId: string; message: string }[]>;
  /** Hands `row` to one module's consumer again: as the same delivery (its event id), or as a fresh one (`eventId`, no stored answer). */
  redeliver: (row: OutboxRow, moduleId: string, eventId?: string) => Promise<void>;
  outbox: (event: string, key: string, value: string) => Promise<OutboxRow[]>;
  day: (month: number, d?: number) => string;
  cleanup: () => Promise<void>;
}

export async function warehouseHarness(nit: string): Promise<Harness> {
  const sql = testDb();
  const exportsStore = new MemoryFileStore();
  setExportsStore(exportsStore);
  registerCountryPack(co);
  for (const m of [core, inventory, costing, sales, accounting, warehouse]) await syncModuleManifest(sql, m);
  const seed = await seedTenant(sql, {
    companies: 1,
    entitlements: ["module:core", "module:accounting", "module:inventory", "module:costing", "module:sales", "module:warehouse"],
  });
  const companyId = seed.companies[0]!.id;
  for (const id of PROCESS_IDS) {
    await sql`insert into kernel.process_permissions(company_id, role_id, process_id) values (${companyId}, ${seed.companies[0]!.adminRoleId}, ${id}) on conflict do nothing`;
  }
  const admin: Caller = { claims: seed.claimsFor(seed.users.both, companyId) as JwtClaims, origin: "ui" };
  const run = <T = unknown>(processId: string, input: unknown, caller: Caller = admin) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;
  const runStepUp = async <T = unknown>(processId: string, input: unknown) => {
    const stepUpToken = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${admin.claims.sub}, ${companyId}, ${stepUpToken})`;
    return runProcess({ sql, registry }, { ...admin, stepUpToken }, processId, input) as Promise<T>;
  };
  const refusal = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as Refusal;

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
  const redeliver = async (row: OutboxRow, moduleId: string, eventId: string = row.id) => {
    const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId)!;
    await consumer.fn(buildConsumerContext(sql, { id: eventId, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };
  const outbox = (event: string, key: string, value: string) =>
    sql<OutboxRow[]>`select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = ${event} and payload->>${key} = ${value} order by created_at`;

  await runStepUp("accounting.chart.seed", {});
  const [fy] = await sql<{ year: number }[]>`select year from accounting.fiscal_years where company_id = ${companyId}`;
  const year = fy!.year;
  await sql`update accounting.settings set ledger_starts_on = ${`${year}-01-01`} where company_id = ${companyId}`;
  const partyId = (await run<{ id: string }>("core.party.create", customer(nit, `Distribuidora ${nit} S.A.S.`))).id;
  for (const tag of ["RUT", "Cámara de Comercio"]) {
    await sql`insert into kernel.attachments (company_id, entity, record_id, tag, file_name, mime_type, size_bytes, storage_path)
      values (${companyId}, 'core.party', ${partyId}, ${tag}, ${`${tag}.pdf`}, 'application/pdf', 1024, ${`${seed.tenantId}/${companyId}/core.party/${partyId}/${randomUUID()}.pdf`})`;
  }
  const warehouseId = (await run<{ id: string }>("inventory.warehouse.create", { code: "PRI", name: "Bodega principal", allowBackorders: false })).id;
  const day = (month: number, d = 15) => `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const cleanup = async () => {
    const companyIds = seed.companies.map((c) => c.id);
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
    await sql.end();
  };

  return { sql, seed, companyId, admin, partyId, warehouseId, year, exportsStore, run, runStepUp, refusal, drain, redeliver, outbox, day, cleanup };
}

/** A pedido confirmed and its events drained; its line ids in order. */
export async function confirmedOrder(h: Harness, lines: { productId: string; qty: number }[]) {
  const order = await h.run<{ id: string }>("sales.order.create", { partyId: h.partyId, issueDate: h.day(3, 1), warehouseId: h.warehouseId, lines: lines.map((l) => ({ ...l, unitPrice: 20000 })) });
  await h.run("sales.order.confirm", { id: order.id });
  expect(await h.drain()).toEqual([]);
  const ids = await h.sql<{ id: string }[]>`select id from sales.order_lines where order_id = ${order.id} order by line_no`;
  return { id: order.id, lineIds: ids.map((l) => l.id) };
}
