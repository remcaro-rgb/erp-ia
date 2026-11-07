// Test helper (e2e, plan 2B Task 38): a process-raised recommendation through the pipeline, never raw SQL. As the fixture's user (origin
// ui) it creates a good, a bodega with its ubicación and posts a receipt without a cost, then hands the movement's
// inventory.movement.posted row to costing's consumer (origin event, as the dispatch workflow's step does; the e2e stack runs no worker):
// costing opens its cost_missing row and raises the kernel recommendation for the holders of inventory.adjustment.post. The caller's role
// must hold the processes it runs and the company a system admin role (the consumer runs as it). Prints the ids as JSON.
// `tsx test-support/raise-cost-missing.mts <company id> <user id>`
import postgres from "postgres";
import { translate } from "@erp/i18n";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { invoicing } from "@erp/module-invoicing";
import { inventory } from "@erp/module-inventory";
import { payments } from "@erp/module-payments";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, syncRegistry, type Caller } from "@erp/kernel";
import { testEnv } from "./env";

const [companyId, userId] = process.argv.slice(2);
if (!companyId || !userId) throw new Error("usage: raise-cost-missing.mts <company id> <user id>");

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  await syncRegistry(sql, registry);
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
  const roles = await sql<{ id: string }[]>`
    select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${userId} and m.company_id = ${companyId}`;
  const caller: Caller = {
    claims: { sub: userId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" },
    origin: "ui",
  };
  const run = <T,>(processId: string, input: unknown) => runProcess({ sql, registry }, caller, processId, input) as Promise<T>;

  const product = await run<{ id: string }>("core.product.create", {
    sku: "REC-CAF-250", description: "Café Pendiente 250 g", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 15000, isFreeSample: false, trackStock: true,
  });
  const warehouseId = (await run<{ id: string }>("inventory.warehouse.create", { code: "PEND", name: "Bodega Pendientes", allowBackorders: false })).id;
  const locationId = (await run<{ id: string }>("inventory.location.create", { warehouseId, code: "P1", name: "Estante P1" })).id;
  const movement = await run<{ id: string }>("inventory.movement.post", { kind: "receipt", date: "2026-03-12", warehouseId, lines: [{ productId: product.id, locationId, qty: 6 }] });

  const [row] = await sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
    select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.posted' and payload->>'movementId' = ${movement.id}`;
  if (!row) throw new Error(`no inventory.movement.posted row for ${movement.id}`);
  const consumer = consumers.for(row.event).find((c) => c.moduleId === "costing");
  if (!consumer) throw new Error("no costing consumer of inventory.movement.posted");
  await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  const [missing] = await sql<{ id: string }[]>`select id from costing.cost_missing where company_id = ${companyId} and product_id = ${product.id}`;
  console.log(JSON.stringify({ productId: product.id, warehouseId, movementId: movement.id, missingId: missing?.id ?? null }));
} finally {
  await sql.end({ timeout: 5 });
}
// The kernel's own pools keep handles open: the run is done.
process.exit(0);
