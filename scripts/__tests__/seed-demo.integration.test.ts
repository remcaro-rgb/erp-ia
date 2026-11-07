import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getServiceDb } from "@erp/kernel";
import { DEMO_COMPANY_ID } from "../demo/accounts";
import { SAMPLE_COMPROBANTES } from "../demo/accounting";
import { ALMACENES_EXITO, CHAIN, PRICE_LIST, SALES_CHAIN_MODULES, WAREHOUSE, wholesalePrice } from "../demo/sales";

// The whole demo seed against the local stack (owner order 2026-11-02): `DEMO_SEED=1 pnpm db:seed` must finish, with a posted
// and balanced opening and the October sample comprobantes posted; and (plan 2B Task 26) the sale chain's modules entitled to the demo
// tenant only and enabled, stock in Bodega Principal, and one sale gone the whole way: cotización → pedido → entrega → factura accepted
// by the (mock) DIAN → recibo, the invoice paid. It writes the demo company, so it runs only on request:
//   pnpm db:reset && cd scripts && DEMO_SEED=1 pnpm exec vitest run seed-demo
const enabled = process.env.DEMO_SEED === "1";
const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");

describe.skipIf(!enabled)("DEMO_SEED=1 pnpm db:seed", () => {
  it("completes, with the 2026 opening posted and balanced and the October sample comprobantes posted", async () => {
    execFileSync("pnpm", ["db:seed"], { cwd: ROOT, env: { ...process.env, DEMO_SEED: "1" }, stdio: "inherit" });
    await import("../env");
    const sql = getServiceDb();
    try {
      const [opening] = await sql<{ debit: string; credit: string; lines: number }[]>`
        select sum(l.debit)::text as debit, sum(l.credit)::text as credit, count(*)::int as lines
        from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id
        where e.company_id = ${DEMO_COMPANY_ID} and e.is_opening and e.status = 'posted'`;
      expect(opening!.lines).toBeGreaterThan(0);
      expect(Number(opening!.debit)).toBeGreaterThan(0);
      expect(Number(opening!.debit)).toBe(Number(opening!.credit));
      const posted = await sql<{ description: string }[]>`
        select description from accounting.entries
        where company_id = ${DEMO_COMPANY_ID} and status = 'posted' and description = any(${SAMPLE_COMPROBANTES.map((c) => c.description)})`;
      expect(posted.map((r) => r.description).sort()).toEqual(SAMPLE_COMPROBANTES.map((c) => c.description).sort());

      const keys = SALES_CHAIN_MODULES.map((m) => `module:${m}`);
      const entitled = await sql<{ tenant_id: string; key: string }[]>`
        select tenant_id, key from kernel.tenant_entitlements where key = any(${keys}) and enabled and company_id is null`;
      const [company] = await sql<{ tenant_id: string }[]>`select tenant_id from kernel.companies where id = ${DEMO_COMPANY_ID}`;
      const demoTenant = company!.tenant_id;
      expect(entitled.filter((e) => e.tenant_id === demoTenant).map((e) => e.key).sort()).toEqual([...keys].sort());
      // No other tenant gets them by default: no plan includes them (the local stack's test tenants hold their own fixtures' grants).
      expect(await sql`select id from kernel.plans where included_keys && ${keys}::text[]`).toEqual([]);
      const enabledModules = await sql<{ module_id: string }[]>`
        select module_id from kernel.company_modules where company_id = ${DEMO_COMPANY_ID} and module_id = any(${[...SALES_CHAIN_MODULES]}) and enabled`;
      expect(enabledModules.map((m) => m.module_id).sort()).toEqual([...SALES_CHAIN_MODULES].sort());
      const [stock] = await sql<{ on_hand: string }[]>`
        select coalesce(sum(s.on_hand), 0)::text as on_hand from inventory.stock_levels s join inventory.warehouses w on w.id = s.warehouse_id
        where s.company_id = ${DEMO_COMPANY_ID} and w.code = ${WAREHOUSE.code}`;
      expect(Number(stock!.on_hand)).toBeGreaterThan(0);
      const [chain] = await sql<{ quote: string; order: string; delivery: string }[]>`
        select q.stage as quote, o.stage as order, d.stage as delivery
        from crm.quotes q join core.parties p on p.id = q.party_id join sales.orders o on o.quote_id = q.id join sales.deliveries d on d.order_id = o.id
        where q.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${ALMACENES_EXITO} order by q.created_at limit 1`;
      expect(chain).toEqual({ quote: "accepted", order: "delivered", delivery: "shipped" });
      const [invoice] = await sql<{ stage: string; dian: string; total: number; paid: number }[]>`
        select i.stage, i.dian_status as dian, i.total::float8 as total, i.paid_amount::float8 as paid
        from invoicing.invoices i join core.parties p on p.id = i.party_id
        where i.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${ALMACENES_EXITO} order by i.created_at limit 1`;
      expect(invoice).toEqual({ stage: "paid", dian: "accepted", total: CHAIN.total, paid: CHAIN.total });

      // Task 51: the price list Mayoristas, every demo good 10 % under its list price, named in the club's terms.
      const [list] = await sql<{ id: string; status: string; currency_code: string }[]>`
        select id, status, currency_code from core.price_lists where company_id = ${DEMO_COMPANY_ID} and name = ${PRICE_LIST.name}`;
      expect(list).toMatchObject({ status: "saved", currency_code: PRICE_LIST.currencyCode });
      const goods = await sql<{ id: string; list_price: string }[]>`
        select id, list_price::text from core.products where company_id = ${DEMO_COMPANY_ID} and kind = 'good' and is_active and list_price > 0`;
      const prices = new Map((await sql<{ product_id: string; price: string }[]>`select product_id, price::text from core.price_list_items where price_list_id = ${list!.id}`).map((r) => [r.product_id, Number(r.price)]));
      expect(goods.length).toBeGreaterThan(0);
      for (const good of goods) expect(prices.get(good.id), good.id).toBe(wholesalePrice(Number(good.list_price)));
      const [terms] = await sql<{ price_list_id: string }[]>`
        select t.price_list_id from sales.customer_terms t join core.parties p on p.id = t.party_id where t.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${ALMACENES_EXITO}`;
      expect(terms!.price_list_id).toBe(list!.id);
    } finally {
      await sql.end();
    }
  }, 600_000);
});
