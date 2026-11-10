import { defineProcess, ProcessError, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import type { CommissionBasis } from "../entities";
import { planFor, type Plan } from "./commission-plan";

// Commissions (plan 2B.2 Task 30.1, Part G design PG §5.2, §5.5; owner items 157, 158, 162, 163; RG-11, RG-12, RG-14; migration 0156).
//
// sales.commission.compute runs from sales' consumer of invoicing.invoice.issued, as a SECOND run after sales.delivery.record_invoiced (a
// separate transaction: a compute that fails never rolls back what the entregas recorded, RG-12). It writes one base per commission line of
// the payload (an invoice line billed from a pedido; invoicing leaves out the free samples) whose pedido has an owner with an active plan at
// the invoice's date: the payee, the plan and the basis of the company (sales.settings.commission_basis) at that moment, the rate frozen (the
// plan's line of the line's category, else its default rate), the base in pesos (`subtotal`, the line's subtotal before taxes, after
// discounts, item 158) and in the invoice's currency (`subtotalDoc`) with its rate (rule 8), and the commission on each, half up to the cent.
// An invoice not billed from a pedido has no salesperson and earns nothing (item 157). Idempotent on the invoice (its key, and one base per
// invoice line): a redelivery writes nothing twice. It posts nothing: when it wrote a base it emits sales.commission.due { invoiceId, basis },
// which Task 30.2's own consumer accrues and posts, so a posting failure parks or retries only that event.
//
// sales.commission.consult_all is the «all commissions» permission of the record rule (item 163): who may run it reads every plan, base and
// commission of the company. Kind update, not consult (owner 2026-11-10, item 167): a new role gets every consult process by default
// (kernel.seed_role_defaults) and so would see everyone's pay; an update permission is granted on purpose, as sales.order.reassign is.

export const FEATURE_COMMISSIONS = "sales.commissions";
export const COMMISSION_DUE = "sales.commission.due";
const NUMBER_PREFIX = "COM-";

const id = z.uuid();
const amount = z.number().finite();

/** One invoice line billed from a pedido (invoicing.invoice.issued `commissionLines`, Task 30.1). */
const commissionLine = z.looseObject({
  invoiceLineId: id,
  orderId: id,
  orderLineId: id,
  productId: id.nullable().optional(),
  categoryId: id.nullable().optional(),
  subtotal: amount,
  subtotalDoc: amount,
  costCenterId: id.nullable().optional(),
});

/** What compute reads of the issued invoice's payload. */
export const issuedForCommission = z.looseObject({
  invoiceId: id,
  number: z.string().nullable().optional(),
  date: z.iso.date(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/).default("COP"),
  exchangeRate: z.number().positive().default(1),
  costCenterId: id.nullable().optional(),
  commissionLines: z.array(commissionLine).max(5000).default([]),
});

export const commissionCompute = defineProcess({
  id: "sales.commission.compute",
  module: "sales",
  kind: "create",
  // The bases of an issued invoice, named by invoicing's event: no record of the caller's is created from the screen.
  recordAccess: "none",
  feature: FEATURE_COMMISSIONS,
  origins: ["event"],
  emits: [COMMISSION_DUE],
  description:
    "Calcula las bases de comisión de una factura emitida: por cada línea facturada de un pedido cuyo vendedor tiene un plan activo, la tasa y el valor de la comisión; solo lo ejecuta el evento de la factura",
  // Once per invoice: a redelivery answers the first run.
  idempotencyKey: (input) => `compute:${(input as { invoiceId: string }).invoiceId}`,
  input: issuedForCommission,
  output: z.object({ bases: z.number().int() }),
  handler: async (ctx, invoice) => {
    if (invoice.commissionLines.length === 0) return { bases: 0 };
    const [settings] = await ctx.tx<{ commission_basis: CommissionBasis }[]>`select commission_basis from sales.settings where company_id = ${ctx.companyId}`;
    const basis: CommissionBasis = settings?.commission_basis ?? "on_collection";
    const orderIds = [...new Set(invoice.commissionLines.map((l) => l.orderId))];
    const owners = new Map((await ctx.tx<{ id: string; owner_id: string | null }[]>`
      select id, owner_id from sales.orders where id = any(${orderIds}::uuid[])`).map((o) => [o.id, o.owner_id]));
    const plans = new Map<string, Plan | null>();
    const rows: Record<string, unknown>[] = [];
    for (const line of invoice.commissionLines) {
      const owner = owners.get(line.orderId);
      if (!owner) continue;
      if (!plans.has(owner)) plans.set(owner, await planFor(ctx.tx, owner, invoice.date));
      const plan = plans.get(owner);
      if (!plan) continue;
      const rate = (line.categoryId ? plan.rates.get(line.categoryId) : undefined) ?? plan.defaultRatePct;
      rows.push({
        invoiceLineId: line.invoiceLineId, orderId: line.orderId, orderLineId: line.orderLineId, productId: line.productId ?? null, categoryId: line.categoryId ?? null,
        costCenterId: line.costCenterId ?? invoice.costCenterId ?? null, userId: owner, planId: plan.id, payeePartyId: plan.payeePartyId, payeeKind: plan.payeeKind,
        rate: String(rate), base: String(line.subtotal), baseDoc: String(line.subtotalDoc),
      });
    }
    if (rows.length === 0) return { bases: 0 };
    // The amounts in numeric (half away from zero, to the cent), never in floating point: 5 % of 40.000,10 is 2.000,01.
    const written = await ctx.tx<{ id: string }[]>`
      insert into sales.commission_bases (company_id, invoice_id, invoice_number, invoice_line_id, invoice_date, order_id, order_line_id, product_id,
        category_id, cost_center_id, user_id, plan_id, payee_party_id, payee_kind, basis, rate_pct, currency, exchange_rate, base, base_doc, commission, commission_doc)
      select ${ctx.companyId}, ${invoice.invoiceId}, ${invoice.number ?? null}, r."invoiceLineId", ${invoice.date}::date, r."orderId", r."orderLineId", r."productId",
             r."categoryId", r."costCenterId", r."userId", r."planId", r."payeePartyId", r."payeeKind", ${basis}, r.rate::numeric, ${invoice.currency},
             ${invoice.exchangeRate}, r.base::numeric, r."baseDoc"::numeric,
             round(r.base::numeric * r.rate::numeric / 100, 2), round(r."baseDoc"::numeric * r.rate::numeric / 100, 2)
      from jsonb_to_recordset(${ctx.tx.json(rows as never)}::jsonb) as r("invoiceLineId" uuid, "orderId" uuid, "orderLineId" uuid, "productId" uuid,
        "categoryId" uuid, "costCenterId" uuid, "userId" uuid, "planId" uuid, "payeePartyId" uuid, "payeeKind" text, rate text, base text, "baseDoc" text)
      on conflict (company_id, invoice_line_id) do nothing
      returning id`;
    if (written.length > 0) await ctx.emit(COMMISSION_DUE, { invoiceId: invoice.invoiceId, basis });
    return { bases: written.length };
  },
});

export const commissionConsultAll = defineProcess({
  id: "sales.commission.consult_all",
  module: "sales",
  kind: "update",
  recordAccess: "none",
  feature: FEATURE_COMMISSIONS,
  description:
    "Permiso para ver los planes, las bases y las comisiones de todos los vendedores (sin él, cada vendedor ve solo los de sus planes); no cambia nada",
  input: z.object({}).strict(),
  output: z.object({ allowed: z.literal(true) }),
  handler: async () => ({ allowed: true as const }),
});

/**
 * The lifecycle hooks of a commission (Task 30.2 writes them): numbered COM- on save from the company counter; the generic Grabar changes
 * no data of it (a commission changes only through the sales.commission processes).
 */
export const commissionHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data);
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for sales.commission.save", { details: refused.map((name) => `El campo ${name} de una comisión no se modifica con Grabar`) });
  },
  async number(ctx) {
    const [row] = await ctx.tx<{ number: string }[]>`select sales.next_number(${ctx.companyId}, ${NUMBER_PREFIX}) as number`;
    return row!.number;
  },
};

export const COMMISSION_PROCESSES = [commissionCompute, commissionConsultAll];
