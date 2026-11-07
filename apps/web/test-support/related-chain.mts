// Test helper (e2e, Task 31 stage D): the sale chain of the related-documents tab, run through the registered processes as the fixture's
// administrator after `invoicing-chain.mts <company> <user>` has configured the company (accounting, DIAN resolution, customers ready to invoice,
// stock): a quote to the customer is written, sent and accepted; an order is made from it, confirmed and delivered; the delivery is invoiced and
// the invoice issued (the mock DIAN accepts it before `pay`). Prints the ids as JSON.
//   tsx test-support/related-chain.mts <company id> <user id> sale <customer document>
//   tsx test-support/related-chain.mts <company id> <user id> pay <invoice id>      a receipt over the invoice's whole balance
//   tsx test-support/related-chain.mts <company id> <user id> void <receipt id>     «Anular recibo» (step-up)
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
import { kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, type Caller } from "@erp/kernel";
import { testEnv } from "./env";

const [companyId, userId, step, arg] = process.argv.slice(2);
if (!companyId || !userId || !step || !arg) throw new Error("usage: related-chain.mts <company id> <user id> <sale|pay|void> <customer document|invoice id|receipt id>");

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
  const roles = await sql<{ id: string }[]>`
    select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${userId} and m.company_id = ${companyId}`;
  const caller: Caller = {
    claims: { sub: userId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" },
    origin: "ui",
  };
  const run = async <T = unknown,>(processId: string, input: unknown, stepUp = false): Promise<T> => {
    if (!stepUp) return (await runProcess({ sql, registry }, caller, processId, input)) as T;
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${userId}, ${companyId}, ${token})`;
    return (await runProcess({ sql, registry }, { ...caller, stepUpToken: token }, processId, input)) as T;
  };
  const today = (await sql<{ d: string }[]>`select (now() at time zone 'America/Bogota')::date::text as d`)[0]!.d;
  const plus30 = (await sql<{ d: string }[]>`select ((now() at time zone 'America/Bogota')::date + 30)::text as d`)[0]!.d;
  const ids: Record<string, unknown> = {};

  if (step === "sale") {
    const [party] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and document_number = ${arg}`;
    const [warehouse] = await sql<{ id: string }[]>`select id from inventory.warehouses where company_id = ${companyId} and code = 'PRIN'`;
    const [costCenter] = await sql<{ id: string }[]>`select id from accounting.cost_centers where company_id = ${companyId} and code = 'VTA'`;
    const [product] = await sql<{ id: string }[]>`select id from core.products where company_id = ${companyId} and sku = 'FAC-CAF-500'`;
    const pipeline = await run<{ id: string }>("crm.pipeline.create", {
      code: "VENTAS", name: "Embudo de ventas",
      stages: [{ name: "Nuevo", probability: 10, kind: "open" }, { name: "Propuesta", probability: 60, kind: "open" }, { name: "Ganada", probability: 100, kind: "won" }, { name: "Perdida", probability: 0, kind: "lost" }],
    });
    const opportunity = await run<{ id: string }>("crm.opportunity.create", { title: "Café para la tienda", partyId: party!.id, pipelineId: pipeline.id });
    const quote = await run<{ id: string; number: string }>("crm.quote.create", { partyId: party!.id, opportunityId: opportunity.id, issueDate: today, validUntil: plus30, lines: [{ productId: product!.id, qty: 2 }] });
    await run("crm.quote.send", { id: quote.id });
    await run("crm.quote.accept", { id: quote.id });
    const order = await run<{ id: string; number: string }>("sales.order.from_quote", { quoteId: quote.id, warehouseId: warehouse!.id, issueDate: today });
    await run("sales.order.confirm", { id: order.id });
    const delivery = await run<{ id: string; number: string }>("sales.delivery.create", { orderId: order.id, date: today, costCenterId: costCenter!.id });
    await run("sales.delivery.ship", { id: delivery.id });
    const created = await run<{ invoices: { id: string }[] }>("invoicing.invoice.from_orders", { orderIds: [order.id] });
    const issued = await run<{ id: string; number: string }>("invoicing.invoice.issue", { id: created.invoices[0]!.id, idempotencyKey: randomUUID() });
    Object.assign(ids, { partyId: party!.id, quote, order, delivery, invoice: issued });
  } else if (step === "pay") {
    const [invoice] = await sql<{ party_id: string; total: string; paid_amount: string }[]>`select party_id, total::text, paid_amount::text from invoicing.invoices where id = ${arg}`;
    const method = await run<{ id: string }>("payments.method.create", { code: `transfer-${randomUUID().slice(0, 6)}`, name: "Transferencia", kind: "transfer", meansCode: "47" });
    const amount = Number(invoice!.total) - Number(invoice!.paid_amount);
    const receipt = await run<{ id: string; number: string }>("payments.payment.receive", { partyId: invoice!.party_id, methodId: method.id, amount, date: today, allocations: [{ invoiceId: arg, amount }] });
    Object.assign(ids, { receipt });
  } else if (step === "void") {
    await run("payments.payment.void", { id: arg, reason: "Consignación devuelta" }, true);
    Object.assign(ids, { voided: arg });
  } else {
    throw new Error(`unknown step ${step}`);
  }
  console.log(JSON.stringify(ids));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
