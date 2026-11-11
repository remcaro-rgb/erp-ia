// Test helper (e2e, plan 2B Task 39): two salespeople on the demo company, made through the admin processes as its administrator (a
// step-up token where the process asks for one), and a pedido of each written as that salesperson. The role «Vendedor e2e» may create and
// consult pedidos, nothing else: it holds no sales.order.reassign, so each salesperson reads only their own pedidos. The users are fixed
// (reused by the next run, signed in with the password set here) and deactivated by `teardown`.
//   tsx test-support/order-owner-chain.mts <company id> <admin user id> setup            prints { roleId, a: {id, email, password}, b: {...} }
//   tsx test-support/order-owner-chain.mts <company id> <admin user id> order <user id> <customer document>   prints { id, number }
//   tsx test-support/order-owner-chain.mts <company id> <admin user id> deliver <order id>   the administrator confirms the pedido and writes its entrega; prints { id, number }
//   tsx test-support/order-owner-chain.mts <company id> <admin user id> close <order id> [delivery id]   voids the entrega and cancels the pedido
//   tsx test-support/order-owner-chain.mts <company id> <admin user id> teardown          deactivates both salespeople
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
import { kernelModule, loadModules, registerCatalogue, registerCountryPack, Registry, runProcess, type Caller } from "@erp/kernel";
import { adminClient } from "./auth-fixtures";
import { testEnv } from "./env";

const [companyId, adminId, step, arg, customer] = process.argv.slice(2);
if (!companyId || !adminId || !step) throw new Error("usage: order-owner-chain.mts <company id> <admin user id> <setup|order|teardown> [user id] [customer document]");

const ROLE = "Vendedor e2e";
const SELLERS = [
  { key: "a", name: "Vendedora e2e A", email: "vendedora-a@e2e.local", mobile: "3105550101", password: "e2e-vendedora-a-2026" },
  { key: "b", name: "Vendedor e2e B", email: "vendedor-b@e2e.local", mobile: "3105550102", password: "e2e-vendedor-b-2026" },
] as const;

// The invitation of kernel.admin.user.create goes through the Auth admin API.
process.env.SUPABASE_URL ??= testEnv().NEXT_PUBLIC_SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY ??= testEnv().SUPABASE_SERVICE_ROLE_KEY;

const sql = postgres(testEnv().DATABASE_URL, { max: 2, onnotice: () => {} });
try {
  const registry = new Registry();
  loadModules(registry, [kernelModule, core, accounting, support, inventory, costing, sales, crm, invoicing, payments, warehouseModule]);
  registerCountryPack({ ...co, einvoice: einvoicePack });
  registerCatalogue(translate);
  const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${companyId}`;
  const callerOf = async (userId: string): Promise<Caller> => {
    const roles = await sql<{ id: string }[]>`
      select mr.role_id as id from kernel.membership_roles mr join kernel.memberships m on m.id = mr.membership_id where m.user_id = ${userId} and m.company_id = ${companyId}`;
    return { claims: { sub: userId, tenant_id: company!.tenant_id, company_ids: [companyId], active_company_id: companyId, role_ids: roles.map((r) => r.id), locale: "es-419" }, origin: "ui" };
  };
  const run = async <T = unknown,>(userId: string, processId: string, input: unknown, stepUp = false): Promise<T> => {
    const caller = await callerOf(userId);
    if (!stepUp) return (await runProcess({ sql, registry }, caller, processId, input)) as T;
    const token = randomUUID();
    await sql`insert into kernel.step_up_verifications(user_id, company_id, token) values (${userId}, ${companyId}, ${token})`;
    return (await runProcess({ sql, registry }, { ...caller, stepUpToken: token }, processId, input)) as T;
  };
  const out: Record<string, unknown> = {};

  if (step === "setup") {
    let [role] = await sql<{ id: string }[]>`select id from kernel.roles where company_id = ${companyId} and name = ${ROLE}`;
    if (!role) role = await run<{ id: string }>(adminId, "kernel.admin.role.create", { name: ROLE, description: "Vendedor de las pruebas e2e: sus propios pedidos", partyScope: "clientes" }, true);
    await run(adminId, "kernel.admin.permission.set_many", { changes: ["sales.order.create"].map((processId) => ({ roleId: role!.id, processId, allowed: true })) }, true);
    const auth = adminClient();
    for (const seller of SELLERS) {
      let [user] = await sql<{ id: string }[]>`select id from kernel.users where email = ${seller.email}`;
      if (!user) {
        const created = await run<{ userId: string }>(adminId, "kernel.admin.user.create", { name: seller.name, email: seller.email, mobile: seller.mobile, roleIds: [role.id] }, true);
        user = { id: created.userId };
      }
      const { error } = await auth.auth.admin.updateUserById(user.id, { password: seller.password, email_confirm: true });
      if (error) throw new Error(`could not set the password of ${seller.email}: ${error.message}`);
      await sql`update kernel.memberships set is_active = true, mfa_required = false where user_id = ${user.id} and company_id = ${companyId}`;
      out[seller.key] = { id: user.id, email: seller.email, password: seller.password, name: seller.name };
    }
    out.roleId = role.id;
  } else if (step === "order") {
    if (!arg || !customer) throw new Error("order needs a user id and a customer document");
    const [party] = await sql<{ id: string }[]>`select id from core.parties where company_id = ${companyId} and document_number = ${customer}`;
    const [warehouse] = await sql<{ id: string }[]>`select id from inventory.warehouses where company_id = ${companyId} and code = 'PRIN' limit 1`;
    const [product] = await sql<{ id: string }[]>`select id from core.products where company_id = ${companyId} and sku = 'CAF-GRA-KG'`;
    const order = await run<{ id: string; number: string }>(arg, "sales.order.create", { partyId: party!.id, ...(warehouse ? { warehouseId: warehouse.id } : {}), lines: [{ productId: product!.id, qty: 1 }] });
    Object.assign(out, { id: order.id, number: order.number });
  } else if (step === "deliver") {
    if (!arg) throw new Error("deliver needs an order id");
    await run(adminId, "sales.order.confirm", { id: arg });
    const delivery = await run<{ id: string; number: string }>(adminId, "sales.delivery.create", { orderId: arg });
    Object.assign(out, { id: delivery.id, number: delivery.number });
  } else if (step === "close") {
    if (!arg) throw new Error("close needs an order id");
    if (customer) await run(adminId, "sales.delivery.void", { id: customer, reason: "Prueba e2e" });
    await run(adminId, "sales.order.cancel", { id: arg, reason: "Prueba e2e" });
    out.closed = arg;
  } else if (step === "teardown") {
    for (const seller of SELLERS) await sql`update kernel.memberships set is_active = false where company_id = ${companyId} and user_id = (select id from kernel.users where email = ${seller.email})`;
    out.deactivated = SELLERS.map((s) => s.email);
  } else {
    throw new Error(`unknown step ${step}`);
  }
  console.log(JSON.stringify(out));
} finally {
  await sql.end({ timeout: 5 });
}
process.exit(0);
