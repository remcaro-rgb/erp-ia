// Test helper (e2e, plan 2B.2 Task 29.4): Bodega's causal chains on the demo company, as the dispatch workflow would run them (the e2e stack
// runs no worker).
//   tsx test-support/warehouse-chain.mts <company id> <admin user id> drain <since ISO time>
//     hands every undispatched outbox row of the company written since then to each consumer of its event (a module the company does not
//     have consumes nothing, as the dispatcher's gate), until nothing new is emitted: a confirmed pedido makes its alistamiento, a confirmed
//     alistamiento is allocated and gets its Borrador entrega, a shipped entrega moves the stock, a put-away relocates it.
//   tsx test-support/warehouse-chain.mts <company id> <admin user id> receipt <sku> <qty> <location code> <reference>
//     posts a receipt (inventory.movement.post as the admin, origin ui) of the product at the ubicación of Bodega Principal, drains it and
//     prints its id and number.
import { randomUUID } from "node:crypto";
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
import { buildConsumerContext, consumers, moduleGate, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, type Caller } from "@erp/kernel";
import { testEnv } from "./env";

const [companyId, adminId, step, ...args] = process.argv.slice(2);
if (!companyId || !adminId || (step !== "drain" && step !== "receipt")) {
  throw new Error("usage: warehouse-chain.mts <company id> <admin user id> drain <since> | receipt <sku> <qty> <location code> <reference>");
}

/** Consumers left out: invoicing's DIAN submission starts the e-invoice workflow (no Workflow World here). */
const NOT_RUN = new Set(["invoicing.invoice.issued|invoicing", "invoicing.note.issued|invoicing", "invoicing.invoice.resubmit_requested|invoicing"]);

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments, warehouseModule]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const deps = { sql, registry };

  /** Every undispatched outbox row of the company since `since`, to each consumer of its event, until nothing new is emitted. */
  const drain = async (since: string): Promise<void> => {
    for (let round = 0; round < 30; round++) {
      const rows = await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox
        where company_id = ${companyId} and dispatched_at is null and created_at >= ${since}::timestamptz order by created_at, id`;
      if (rows.length === 0) return;
      for (const row of rows) {
        for (const consumer of consumers.for(row.event)) {
          if (NOT_RUN.has(`${row.event}|${consumer.moduleId}`)) continue;
          if ((await moduleGate(sql, companyId, consumer.moduleId)) !== "enabled") continue;
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
          await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
        }
        await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id} and dispatched_at is null`;
      }
    }
    throw new Error("warehouse-chain: the outbox did not settle");
  };

  if (step === "drain") {
    const [since] = args;
    if (!since) throw new Error("drain needs the time it starts from");
    await drain(since);
    console.log(JSON.stringify({ drained: true }));
  } else {
    const [sku, qty, locationCode, reference] = args;
    if (!sku || !qty || !locationCode || !reference) throw new Error("receipt needs a sku, a quantity, a ubicación code and a reference");
    const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
    const roles = await sql<{ id: string }[]>`
      select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${adminId} and m.company_id = ${companyId}`;
    const admin: Caller = {
      claims: { sub: adminId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" },
      origin: "ui",
      chainId: randomUUID(),
    };
    const [product] = await sql<{ id: string; standard_cost: string | null }[]>`select id, standard_cost::text from core.products where company_id = ${companyId} and sku = ${sku}`;
    const [location] = await sql<{ id: string; warehouse_id: string }[]>`
      select l.id, l.warehouse_id from inventory.locations l join inventory.warehouses w on w.id = l.warehouse_id
      where l.company_id = ${companyId} and w.code = 'PRIN' and l.code = ${locationCode}`;
    const [clock] = await sql<{ now: string; today: string }[]>`select now()::text as now, (now() at time zone 'America/Bogota')::date::text as today`;
    const out = (await runProcess(deps, admin, "inventory.movement.post", {
      kind: "receipt", date: clock!.today, warehouseId: location!.warehouse_id, reference, description: "Entrada de prueba e2e por ubicar",
      lines: [{ productId: product!.id, locationId: location!.id, qty: Number(qty), unitCost: Number(product!.standard_cost ?? 0) }],
    })) as { id: string; number?: string };
    await drain(clock!.now);
    const [movement] = await sql<{ number: string | null }[]>`select number from inventory.movements where id = ${out.id}`;
    console.log(JSON.stringify({ movementId: out.id, number: movement?.number ?? null }));
  }
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
