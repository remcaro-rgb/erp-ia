// Test helper (e2e, plan 2B.2 Task 44): a product received at a real cost in one bodega and then issued, with no cost of its own, from a
// second bodega that allows backorders, through the registered processes as the fixture's user (origin ui), each movement handed to costing's
// consumer (origin event, as the dispatch workflow's step does; the e2e stack runs no worker). Under the company's `unknown_cost_mode =
// last_known` the issue is valued at the receipt's cost (cost_source last_known, cost_missing); under `zero` at 0. The caller's role must hold
// the processes it runs and the company a system admin role (the consumer runs as it). Prints the ids as JSON.
// `tsx test-support/unknown-cost-chain.mts <company id> <user id>`
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
import { warehouse as warehouseModule } from "@erp/module-warehouse";
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, syncRegistry, type Caller } from "@erp/kernel";
import { testEnv } from "./env";

const [companyId, userId] = process.argv.slice(2);
if (!companyId || !userId) throw new Error("usage: unknown-cost-chain.mts <company id> <user id>");

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments, warehouseModule]);
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
  const cost = async (movementId: string) => {
    const [row] = await sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where event = 'inventory.movement.posted' and payload->>'movementId' = ${movementId}`;
    if (!row) throw new Error(`no inventory.movement.posted row for ${movementId}`);
    const consumer = consumers.for(row.event).find((c) => c.moduleId === "costing");
    if (!consumer) throw new Error("no costing consumer of inventory.movement.posted");
    await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
  };

  const product = await run<{ id: string }>("core.product.create", {
    sku: "UNK-CAF-500", description: "Café Estimado 500 g", kind: "good", idScheme: "999", uomCode: "94", ivaRate: "5", otherTaxes: [], listPrice: 20000, isFreeSample: false, trackStock: true,
  });
  const bodega = async (code: string, name: string, allowBackorders: boolean) => {
    const id = (await run<{ id: string }>("inventory.warehouse.create", { code, name, allowBackorders })).id;
    const locationId = (await run<{ id: string }>("inventory.location.create", { warehouseId: id, code: "E1", name: "Estante E1" })).id;
    return { id, locationId };
  };
  const a = await bodega("UCA", "Bodega Costo", false);
  const b = await bodega("UCB", "Bodega Sin Costo", true);
  const receipt = await run<{ id: string }>("inventory.movement.post", { kind: "receipt", date: "2026-03-12", warehouseId: a.id, lines: [{ productId: product.id, locationId: a.locationId, qty: 4, unitCost: 100 }] });
  await cost(receipt.id);
  const issue = await run<{ id: string }>("inventory.movement.post", { kind: "issue", date: "2026-03-12", warehouseId: b.id, lines: [{ productId: product.id, locationId: b.locationId, qty: -2 }] });
  await cost(issue.id);
  console.log(JSON.stringify({ productId: product.id, receiptId: receipt.id, issueId: issue.id }));
} finally {
  await sql.end({ timeout: 5 });
}
// The kernel's own pools keep handles open: the run is done.
process.exit(0);
