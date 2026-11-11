// Test helper (e2e, plan 2B Task 10): delivers one outbox row to one module's consumer of its event, as the dispatch workflow's step does
// (the e2e stack runs no worker). `tsx test-support/deliver-event.mts <outbox id> <module id>`: the accounting consumer posts an
// inventory adjustment's entry, the costing consumer values a receipt into its cost layer.
import postgres from "postgres";
import { translate } from "@erp/i18n";
import { co } from "@erp/loc-co";
import { einvoicePack } from "@erp/loc-co/einvoice";
import { accounting } from "@erp/module-accounting";
import { core } from "@erp/module-core";
import { costing } from "@erp/module-costing";
import { crm } from "@erp/module-crm";
import { invoicing } from "@erp/module-invoicing";
import { payments } from "@erp/module-payments";
import { warehouse as warehouseModule } from "@erp/module-warehouse";
import { sales } from "@erp/module-sales";
import { inventory } from "@erp/module-inventory";
import { support } from "@erp/module-support";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry } from "@erp/kernel";
import { testEnv } from "./env";

const [id, moduleId] = process.argv.slice(2);
if (!id || !moduleId) throw new Error("usage: deliver-event.mts <outbox id> <module id>");

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments, warehouseModule]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const [row] = await sql<{ id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string; company_id: string }[]>`
    select id, event, payload, created_at, chain_id, company_id from kernel.outbox where id = ${id}`;
  if (!row) throw new Error(`outbox row ${id} not found`);
  const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId);
  if (!consumer) throw new Error(`no ${moduleId} consumer of ${row.event}`);
  await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId: row.company_id, chainId: row.chain_id }, registry), row.payload);
  // The dispatch step records the delivery once the consumer returned (events/dispatch.workflow.ts): pending_postings and the drain read it (Task 33).
  await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${moduleId}) on conflict do nothing`;
  console.log(`delivered ${row.event} ${row.id} to ${moduleId}`);
} finally {
  await sql.end({ timeout: 5 });
}
// The kernel's own pools keep handles open: the delivery is done.
process.exit(0);
