import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { getServiceDb } from "@erp/kernel";
import { DEMO_COMPANY_ID } from "../demo/accounts";
import { SAMPLE_COMPROBANTES } from "../demo/accounting";
import { ALMACENES_EXITO, CHAIN, COMMISSION_PLANS, COMMISSION_SALE, FOREIGN_SALE, NORTHWIND, PRICE_LIST, SALES_CHAIN_MODULES, USD_BANK, USD_RATES, WAREHOUSE, wholesalePrice } from "../demo/sales";

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

      // Task 53.3 (R53-2): FE-1015 is annulled by the credit note of annulment NC-303 (the event the real void path emits), posted in VT.
      const [fe1015] = await sql<{ id: string }[]>`
        select id from accounting.entries where company_id = ${DEMO_COMPANY_ID} and status = 'posted' and description like 'Factura FE-1015%' limit 1`;
      const [nc303] = await sql<{ id: string; journal: string; status: string }[]>`
        select e.id, j.code as journal, e.status from accounting.entries e join accounting.journals j on j.id = e.journal_id
        where e.company_id = ${DEMO_COMPANY_ID} and e.description like 'Nota NC-303%'`;
      expect(fe1015).toBeDefined();
      expect(nc303).toMatchObject({ journal: "VT", status: "posted" });
      const [receivable] = await sql<{ balance: string }[]>`
        select coalesce(sum(l.debit - l.credit), 0)::text as balance
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
        where e.company_id = ${DEMO_COMPANY_ID} and e.status = 'posted' and e.id in (${fe1015!.id}, ${nc303!.id}) and a.code like '1305%'`;
      expect(Number(receivable!.balance)).toBe(0);
      const [trial] = await sql<{ debit: string; credit: string }[]>`
        select sum(l.debit)::text as debit, sum(l.credit)::text as credit
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id where e.company_id = ${DEMO_COMPANY_ID} and e.status = 'posted'`;
      expect(Number(trial!.debit)).toBe(Number(trial!.credit));
      const noteEvents = await sql<{ number: string }[]>`
        select payload->>'number' as number from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.note.issued' and payload->>'annulment' = 'true'`;
      expect(noteEvents.map((r) => r.number)).toEqual(["NC-303"]);
      expect(await sql`select 1 from kernel.outbox where company_id = ${DEMO_COMPANY_ID} and event = 'invoicing.invoice.voided' and payload->>'number' = 'FE-1015'`).toEqual([]);

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
        select t.price_list_id from sales.customer_terms t join core.parties p on p.id = t.party_id where t.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${PRICE_LIST.customer}`;
      expect(terms!.price_list_id).toBe(list!.id);

      // Task 34.8 (FX §9): the export sale in dollars. FE-USD is an export (InvoiceTypeCode 02), IVA exento, at its rate; its entry is in USD
      // and balanced in both currencies; the partial USD receipt left USD 7.500 open and posted the realized loss on the dollar account.
      const rates = await sql<{ rate: number; source: string }[]>`
        select rate::float8 as rate, source from core.exchange_rates where company_id = ${DEMO_COMPANY_ID} and currency = 'USD' order by rate_date`;
      expect(rates).toEqual(USD_RATES.map((r) => ({ rate: r.rate, source: "manual" })));
      const [fe] = await sql<{ id: string; currency: string; is_export: boolean; total: number; rate: number; paid: number; stage: string; dian: string; iva: number }[]>`
        select i.id, i.currency, i.is_export, i.total::float8 as total, i.exchange_rate::float8 as rate, i.paid_amount::float8 as paid, i.stage, i.dian_status as dian,
               (select sum(l.iva)::float8 from invoicing.invoice_lines l where l.invoice_id = i.id) as iva
        from invoicing.invoices i join core.parties p on p.id = i.party_id
        where i.company_id = ${DEMO_COMPANY_ID} and p.document_number = ${NORTHWIND.documentNumber} and i.notes = ${FOREIGN_SALE.notes} and i.status <> 'voided'`;
      expect(fe).toMatchObject({ currency: "USD", is_export: true, total: FOREIGN_SALE.total, rate: FOREIGN_SALE.rate, paid: FOREIGN_SALE.receipt.amount, dian: "accepted", iva: 0 });
      expect(FOREIGN_SALE.total - fe!.paid).toBe(FOREIGN_SALE.open);
      const [feEntry] = await sql<{ currency: string; debit: number; credit: number; debit_doc: number; credit_doc: number }[]>`
        select e.currency, sum(l.debit)::float8 as debit, sum(l.credit)::float8 as credit, sum(l.debit_doc)::float8 as debit_doc, sum(l.credit_doc)::float8 as credit_doc
        from accounting.entries e join accounting.entry_lines l on l.entry_id = e.id
        where e.company_id = ${DEMO_COMPANY_ID} and e.source_record_id = ${fe!.id} and e.status = 'posted' and e.reversal_of_id is null group by e.id, e.currency`;
      expect(feEntry).toMatchObject({ currency: "USD", debit_doc: FOREIGN_SALE.total, credit_doc: FOREIGN_SALE.total });
      expect(feEntry!.debit).toBe(feEntry!.credit);
      const receiptLines = await sql<{ code: string; debit: number; credit: number }[]>`
        select a.code, l.debit::float8 as debit, l.credit::float8 as credit
        from payments.receipt_allocations ra join accounting.entries e on e.source_record_id = ra.receipt_id and e.status = 'posted' and e.reversal_of_id is null
        join accounting.entry_lines l on l.entry_id = e.id join accounting.accounts a on a.id = l.account_id
        where ra.invoice_id = ${fe!.id} order by l.line_no`;
      expect(receiptLines).toContainEqual({ code: USD_BANK.code, debit: FOREIGN_SALE.receipt.amount * FOREIGN_SALE.receipt.rate, credit: 0 });
      expect(receiptLines).toContainEqual({ code: "530525", debit: FOREIGN_SALE.realizedLoss, credit: 0 });

      // Task 30.4 (PG §6): the two commission plans (Laura's, an employee party; the external agent's, a supplier party, for Marcela's sales);
      // the sale of «Café molido» collected in two receipts accrued two commissions at the category's 7 %, adding up to the cent; the payable
      // is open for Laura's employee party (Cartera por edades CxP) on 250505, due at +payment_days; the trial balance above stays balanced.
      const plans = await sql<{ name: string; payee_kind: string; rate: number; document: string; users: string[] }[]>`
        select p.name, p.payee_kind, p.default_rate_pct::float8 as rate, pa.document_number as document,
               array(select u.email from sales.commission_plan_users pu join kernel.users u on u.id = pu.user_id where pu.plan_id = p.id order by u.email) as users
        from sales.commission_plans p join core.parties pa on pa.id = p.payee_party_id
        where p.company_id = ${DEMO_COMPANY_ID} and p.is_active and p.deleted_at is null order by p.payee_kind desc`;
      expect(plans).toEqual([
        { name: COMMISSION_PLANS.employee.name, payee_kind: "employee", rate: COMMISSION_PLANS.employee.defaultRatePct, document: COMMISSION_PLANS.employee.party.documentNumber, users: [COMMISSION_PLANS.employee.user] },
        { name: COMMISSION_PLANS.agent.name, payee_kind: "agent", rate: COMMISSION_PLANS.agent.defaultRatePct, document: COMMISSION_PLANS.agent.party.documentNumber, users: [COMMISSION_PLANS.agent.user] },
      ]);
      const [ground] = await sql<{ rate: number }[]>`
        select l.rate_pct::float8 as rate from sales.commission_plan_lines l join sales.commission_plans p on p.id = l.plan_id join core.product_categories c on c.id = l.category_id
        where p.company_id = ${DEMO_COMPANY_ID} and p.name = ${COMMISSION_PLANS.employee.name} and c.name = ${COMMISSION_PLANS.employee.category.name}`;
      expect(ground!.rate).toBe(COMMISSION_PLANS.employee.category.ratePct);
      const [sold] = await sql<{ id: string; stage: string; subtotal: number }[]>`
        select i.id, i.stage, i.subtotal::float8 as subtotal from invoicing.invoices i where i.company_id = ${DEMO_COMPANY_ID} and i.notes = ${COMMISSION_SALE.notes} and i.status <> 'voided'`;
      expect(sold).toMatchObject({ stage: "paid", subtotal: COMMISSION_SALE.subtotal });
      const commissions = await sql<{ number: string; source_kind: string; amount: number; due_date: string; party: string }[]>`
        select distinct c.number, c.source_kind, c.amount::float8 as amount, c.due_date::text, pa.document_number as party, c.seq
        from sales.commissions c join sales.commission_lines l on l.commission_id = c.id join sales.commission_bases b on b.id = l.base_id
        join core.parties pa on pa.id = c.payee_party_id where b.invoice_id = ${sold!.id} order by c.seq`;
      expect(commissions.map((c) => [c.source_kind, c.amount, c.party])).toEqual(COMMISSION_SALE.commissions.map((amount) => ["receipt", amount, COMMISSION_PLANS.employee.party.documentNumber]));
      expect(commissions.reduce((t, c) => t + c.amount, 0)).toBeCloseTo(COMMISSION_SALE.commission, 2);
      // The payable on 250505 for Laura's employee party, due at +payment_days (accounting.open_items reads the caller's claims: the
      // service role sees none, so the ledger balance is read; Cartera por edades itself is checked by e2e sales-commissions.spec.ts).
      const [payable] = await sql<{ open: number; due: string[] }[]>`
        select coalesce(sum(l.credit - l.debit), 0)::float8 as open, array_agg(distinct l.due_date::text) as due
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
        join core.parties pa on pa.id = l.party_id
        where e.company_id = ${DEMO_COMPANY_ID} and e.status = 'posted' and a.code = '250505' and pa.document_number = ${COMMISSION_PLANS.employee.party.documentNumber}`;
      expect(payable!.open).toBeCloseTo(COMMISSION_SALE.commission, 2);
      expect(payable!.due).toEqual(commissions.map((c) => c.due_date).filter((d, k, all) => all.indexOf(d) === k));
    } finally {
      await sql.end();
    }
  }, 600_000);
});
