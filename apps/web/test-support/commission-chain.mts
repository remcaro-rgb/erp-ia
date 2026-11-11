// Test helper (e2e, plan 2B.2 Task 30.4): the sale a commission comes from, on the demo company, through the registered processes (origin
// ui, a step-up token where the process asks for one), and the outbox of its causal chains handed to the consumers as the dispatch
// workflow does (the e2e stack runs no worker): a pedido written as the salesperson, confirmed, delivered, shipped, invoiced from Por
// facturar and issued by the administrator, then accepted by the mock DIAN (the e-invoice workflow's own processes, as mock-dian.mts and the
// demo seed record it; no signing, no transport). Issuing writes the commission bases (sales' consumer of the issued event); a receipt
// registered on screen accrues its share once `drain` hands its payments.received to sales and the commission to accounting.
//   tsx test-support/commission-chain.mts <company id> <admin user id> reset <user id>…                 deactivates the active plans that list them
//   tsx test-support/commission-chain.mts <company id> <admin user id> sale <seller id> <customer document> <sku> <qty>   prints { invoiceId, number, subtotal, total }
//   tsx test-support/commission-chain.mts <company id> <admin user id> drain <payment id>             dispatches the receipt's chains
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
if (!companyId || !adminId || !step) throw new Error("usage: commission-chain.mts <company id> <admin user id> <reset|sale|drain> …");

/** Consumers left out: invoicing's DIAN submission starts the e-invoice workflow (no Workflow World here; the mock DIAN answers instead). */
const NOT_RUN = new Set(["invoicing.invoice.issued|invoicing", "invoicing.note.issued|invoicing", "invoicing.invoice.resubmit_requested|invoicing"]);

interface OutboxRow { id: string; event: string; payload: Record<string, unknown>; created_at: Date; chain_id: string }

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments, warehouseModule]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const deps = { sql, registry };
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
  const chains = new Set<string>();
  const callerOf = async (userId: string): Promise<Caller> => {
    const roles = await sql<{ id: string }[]>`
      select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${userId} and m.company_id = ${companyId}`;
    return { claims: { sub: userId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" }, origin: "ui" };
  };
  const run = async <T = { id: string },>(userId: string, processId: string, input: unknown, stepUp = false): Promise<T> => {
    const chainId = randomUUID();
    chains.add(chainId);
    const caller = { ...(await callerOf(userId)), chainId };
    if (!stepUp) return (await runProcess(deps, caller, processId, input)) as T;
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${userId}, ${companyId}, ${token})`;
    return (await runProcess(deps, { ...caller, stepUpToken: token }, processId, input)) as T;
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
          // As the dispatcher's gate (Task 29.1: Bodega is loaded but not bought here): a module the company does not have consumes nothing.
          if ((await moduleGate(sql, companyId, consumer.moduleId)) !== "enabled") continue;
          const [done] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${row.id} and module_id = ${consumer.moduleId}`;
          if (done) continue;
          await consumer.fn(buildConsumerContext(sql, { id: row.id, event: row.event, createdAt: row.created_at, companyId, chainId: row.chain_id }, registry), row.payload);
          await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${row.id}, ${consumer.moduleId}) on conflict do nothing`;
        }
        await sql`update kernel.outbox set dispatched_at = now() where id = ${row.id} and dispatched_at is null`;
      }
    }
    throw new Error("commission-chain: the outbox did not settle");
  };
  const out: Record<string, unknown> = {};

  if (step === "reset") {
    const plans = await sql<{ id: string }[]>`
      select distinct p.id from sales.commission_plans p join sales.commission_plan_users u on u.plan_id = p.id
      where p.company_id = ${companyId} and p.is_active and p.deleted_at is null and u.user_id = any(${args}::uuid[])`;
    for (const plan of plans) await run(adminId, "sales.commission_plan.update", { id: plan.id, isActive: false });
    out.deactivated = plans.length;
  } else if (step === "sale") {
    const [sellerId, customer, sku, qty] = args;
    if (!sellerId || !customer || !sku || !qty) throw new Error("sale needs a seller id, a customer document, a sku and a quantity");
    const [party] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and document_number = ${customer}`;
    const [product] = await sql<{ id: string }[]>`select id from core.products where company_id = ${companyId} and sku = ${sku}`;
    const [warehouse] = await sql<{ id: string }[]>`select id from inventory.warehouses where company_id = ${companyId} and code = 'PRIN' limit 1`;
    const [costCenter] = await sql<{ id: string }[]>`select id from accounting.cost_centers where company_id = ${companyId} and code = 'TOS'`;
    const order = await run(sellerId, "sales.order.create", { partyId: party!.id, warehouseId: warehouse!.id, lines: [{ productId: product!.id, qty: Number(qty) }], notes: "Prueba e2e de comisiones" });
    await run(adminId, "sales.order.confirm", { id: order.id });
    await drain();
    const delivery = await run(adminId, "sales.delivery.create", { orderId: order.id, ...(costCenter ? { costCenterId: costCenter.id } : {}) });
    await run(adminId, "sales.delivery.ship", { id: delivery.id });
    await drain();
    const { invoices } = await run<{ invoices: { id: string }[] }>(adminId, "invoicing.invoice.from_orders", { orderIds: [order.id] });
    const invoiceId = invoices[0]!.id;
    await run(adminId, "invoicing.invoice.issue", { id: invoiceId, idempotencyKey: `e2e-commission-issue-${invoiceId}` });
    await drain();
    // The mock DIAN accepts it, on the issued event's chain (the e-invoice workflow's processes, as mock-dian.mts records them).
    const [issued] = await sql<OutboxRow[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where company_id = ${companyId} and event = 'invoicing.invoice.issued' and payload->>'invoiceId' = ${invoiceId} order by created_at desc limit 1`;
    const ctx = buildConsumerContext(sql, { id: issued!.id, event: issued!.event, createdAt: issued!.created_at, companyId, chainId: issued!.chain_id }, registry);
    const requested = (await ctx.runProcess("invoicing.einvoice_submission.request", { invoiceId })) as { submissionId: string };
    const runId = `e2e-mock-${randomUUID()}`;
    const claimed = (await ctx.runProcess("invoicing.einvoice_submission.record", { action: "claim", id: requested.submissionId, runId })) as { submission: { round: number } };
    const dir = `${company!.tenant_id}/${companyId}/einvoice/${invoiceId}/r${claimed.submission.round}-${runId}`;
    await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitting", id: requested.submissionId, runId, xmlPath: `${dir}/documento.xml` });
    await ctx.runProcess("invoicing.einvoice_submission.record", { action: "submitted", id: requested.submissionId, runId, trackId: `e2e-mock-${invoiceId.slice(0, 8)}` });
    await ctx.runProcess("invoicing.invoice.dian_result", { id: invoiceId, submissionId: requested.submissionId, runId, status: "accepted", errors: [], xmlPath: `${dir}/documento.xml`, responsePath: `${dir}/respuesta-dian.xml` });
    await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${issued!.id}, 'invoicing') on conflict do nothing`;
    chains.add(issued!.chain_id);
    await drain();
    const [invoice] = await sql<{ number: string; subtotal: number; total: number }[]>`select number, subtotal::float8 as subtotal, total::float8 as total from invoicing.invoices where id = ${invoiceId}`;
    Object.assign(out, { invoiceId, ...invoice, orderId: order.id });
  } else if (step === "drain") {
    const [paymentId] = args;
    const rows = await sql<{ chain_id: string }[]>`select distinct chain_id from kernel.outbox where company_id = ${companyId} and payload->>'paymentId' = ${paymentId!}`;
    for (const r of rows) chains.add(r.chain_id);
    await drain();
    out.chains = rows.length;
  } else {
    throw new Error(`unknown step ${step}`);
  }
  console.log(JSON.stringify(out));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
