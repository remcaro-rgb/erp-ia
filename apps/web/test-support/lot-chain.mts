// Test helper (e2e, plan 2B.2 Task 28.4): the sale of a lot product on the demo company, through the registered processes (origin ui), and the
// outbox of its causal chains handed to the consumers as the dispatch workflow does (the e2e stack runs no worker). The receipt the spec saved
// on screen is first valued by costing (its inventory.movement.posted chain drained); then a pedido is written, confirmed, delivered (FEFO
// picks the lots), shipped and invoiced from Por facturar as a Borrador. Prints the invoice, the entrega's lots and the order.
//   tsx test-support/lot-chain.mts <company id> <admin user id> sale <receipt movement id> <customer document> <sku> <qty>
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
import { sales } from "@erp/module-sales";
import { support } from "@erp/module-support";
import { buildConsumerContext, consumers, kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, type Caller } from "@erp/kernel";
import { testEnv } from "./env";

const [companyId, adminId, step, ...args] = process.argv.slice(2);
if (!companyId || !adminId || step !== "sale") throw new Error("usage: lot-chain.mts <company id> <admin user id> sale <receipt id> <customer document> <sku> <qty>");

/** Consumers left out: invoicing's DIAN submission starts the e-invoice workflow (no Workflow World here). */
const NOT_RUN = new Set(["invoicing.invoice.issued|invoicing", "invoicing.note.issued|invoicing", "invoicing.invoice.resubmit_requested|invoicing"]);

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const deps = { sql, registry };
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
  const chains = new Set<string>();
  const roles = await sql<{ id: string }[]>`
    select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${adminId} and m.company_id = ${companyId}`;
  const admin: Caller = { claims: { sub: adminId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" }, origin: "ui" };
  const run = async <T = { id: string },>(processId: string, input: unknown): Promise<T> => {
    const chainId = randomUUID();
    chains.add(chainId);
    return (await runProcess(deps, { ...admin, chainId }, processId, input)) as T;
  };
  /** Every undispatched outbox row of the chains, to each consumer of its event, until nothing new is emitted (as the demo seed does). */
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 30; round++) {
      const rows = await sql<OutboxRow[]>`
        select id, event, payload, created_at, chain_id from kernel.outbox
        where company_id = ${companyId} and dispatched_at is null and chain_id = any(${[...chains]}::uuid[]) order by created_at, id`;
      if (rows.length === 0) return;
      for (const row of rows) {
        for (const consumer of consumers.for(row.event)) {
          if (NOT_RUN.has(`${row.event}|${consumer.moduleId}`)) continue;
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
          await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
        }
        await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id} and dispatched_at is null`;
      }
    }
    throw new Error("lot-chain: the outbox did not settle");
  };

  const [receiptId, customer, sku, qty] = args;
  if (!receiptId || !customer || !sku || !qty) throw new Error("sale needs a receipt id, a customer document, a sku and a quantity");
  // The receipt saved on screen, valued by costing first (the cost layer the issue consumes).
  for (const r of await sql<{ chain_id: string }[]>`select distinct chain_id from kernel.outbox where company_id = ${companyId} and payload->>'movementId' = ${receiptId}`) chains.add(r.chain_id);
  await drain();
  const [party] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and document_number = ${customer}`;
  const [product] = await sql<{ id: string }[]>`select id from core.products where company_id = ${companyId} and sku = ${sku}`;
  const [warehouse] = await sql<{ id: string }[]>`select id from inventory.warehouses where company_id = ${companyId} and code = 'PRIN' limit 1`;
  const [costCenter] = await sql<{ id: string }[]>`select id from accounting.cost_centers where company_id = ${companyId} and code = 'TOS'`;
  const order = await run("sales.order.create", { partyId: party!.id, warehouseId: warehouse!.id, lines: [{ productId: product!.id, qty: Number(qty) }], notes: "Prueba e2e de lotes" });
  await run("sales.order.confirm", { id: order.id });
  await drain();
  const delivery = await run("sales.delivery.create", { orderId: order.id, ...(costCenter ? { costCenterId: costCenter.id } : {}) });
  await run("sales.delivery.ship", { id: delivery.id });
  await drain();
  const { invoices } = await run<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
  await drain();
  const lots = await sql<{ lot_code: string; qty: number }[]>`
    select x.lot_code, x.qty::float8 as qty from sales.delivery_line_lots x join sales.delivery_lines l on l.id = x.delivery_line_id
    where l.delivery_id = ${delivery.id} order by x.seq`;
  console.log(JSON.stringify({ orderId: order.id, deliveryId: delivery.id, invoiceId: invoices[0]!.id, lots }));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
