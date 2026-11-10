import { defineProcess, emitAndPostStrict, ProcessError, runLifecycle, type EventConsumer, type ProcessContext, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { commissionEntity, type CommissionBasis, type PayeeKind } from "../entities";
import { planFor, type Plan } from "./commission-plan";
import { linksOf } from "./common";

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
/** A commission documento was accrued (Task 30.2): the rule commission-accrued posts it. */
export const COMMISSION_ACCRUED = "sales.commission.accrued";
/** A commission documento was reversed (Task 30.3 emits it): the rule commission-reversed reverses its entry (reverseOf). */
export const COMMISSION_REVERSED = "sales.commission.reversed";
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

// =============================================================================================================================================
// Accrual (plan 2B.2 Task 30.2, Part G PG §5.2, §5.4; owner items 159–162; RG-11, RG-12, RG-13; migration 0157).
//
// sales.commission.accrue turns open bases into commission documentos (COM-n, contabiliza), one per payee and plan and source document, dated
// the source document's date and due `payment_days` after it (the provision's due date in «Cartera por edades» CxP). Its sources:
//   - invoice (basis on_invoice): run by sales' own consumer of sales.commission.due; it accrues `commission − accrued` of every open base of
//     the invoice made under on_invoice. A due event of an on_collection invoice does nothing.
//   - receipt / advance (basis on_collection): run by sales' consumers of payments.received and payments.advance.applied; per allocation to an
//     invoice with open on_collection bases, per base, `remaining × settledDoc / (settledDoc + openAfterDoc)` half up to the cent, where
//     remaining = commission − accrued − reversed (pesos) and settledDoc is what the allocation took off the receivable in the invoice's
//     currency (the receipt's allocation amount already holds the withholdings the customer practised: cash + withholdings, receiptTotals).
//     The allocation that leaves the invoice open at 0 takes the whole remainder, so the accruals add up to the commission to the cent. The
//     ratio is taken in document currency: an exchange difference never changes a commission.
// Each documento lines one row per base (its amount, the base's cost center), raises `accrued` on the base, links the source document to it
// (invoice_to_commission, receipt_to_commission; an advance application is the payments document that settled the invoice, so it links as a
// receipt does) and posts through the typed lifecycle: Grabar numbers it COM- and its post hook emits sales.commission.accrued. Idempotent on
// the source: a redelivery answers the documentos the first run wrote.
//
// Posting (RG-12, the posting mode of Task 33): the entry is written inline in the same run when the ledger accepts it (or queued in the
// asynchronous mode). When the ledger refuses it (the payee no longer invoice-ready, a closed period, an unmapped role), the commission still
// stands and its event goes to the posting engine, which records the refusal as a posting failure (Contabilidad › Pendientes, retried once
// fixed): an accrual runs from another module's event (payments.received is consumed by invoicing too), so a refusal must never fail that
// event, nor sales' consumer of it. With accounting off the event parks and posts when accounting is enabled.

// BigInt(…) rather than literals: the web app compiles this file for a target below ES2020.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const cents = (value: string | number): bigint => {
  const text = typeof value === "number" ? value.toFixed(4) : value;
  const negative = text.trim().startsWith("-");
  const [whole, fraction = ""] = text.trim().replace(/^[-+]/, "").split(".");
  // Half away from zero at the third decimal (the amounts are numeric(18,4) holding cents).
  let c = BigInt(whole || "0") * HUNDRED + BigInt((fraction + "00").slice(0, 2));
  if (Number((fraction + "000").charAt(2)) >= 5) c += ONE;
  return negative ? -c : c;
};
const fromCents = (c: bigint): number => Number(c) / 100;
/** round_half_up(a × b / d) in cents (away from zero), exact: no floating point between the operands. */
const ratio = (a: bigint, b: bigint, d: bigint): bigint => {
  const n = a * b;
  const negative = (n < ZERO) !== (d < ZERO);
  const absN = n < ZERO ? -n : n;
  const absD = d < ZERO ? -d : d;
  const q = (TWO * absN + absD) / (TWO * absD);
  return negative ? -q : q;
};

const allocation = z.object({
  invoiceId: id,
  /** What the allocation took off the invoice's receivable, in the invoice's currency (cash plus the withholdings the customer practised). */
  amount,
  /** The invoice's open balance after this allocation, in its currency (payments, Task 30.1). */
  openAfterDoc: amount,
});
const sourceDate = z.iso.date().optional();

export const accrueInput = z.discriminatedUnion("source", [
  z.object({ source: z.literal("invoice"), invoiceId: id }).strict(),
  z.object({ source: z.literal("receipt"), paymentId: id, date: sourceDate, allocations: z.array(allocation).max(500) }).strict(),
  z.object({ source: z.literal("advance"), applicationId: id, date: sourceDate, allocations: z.array(allocation).max(500) }).strict(),
]);
type AccrueInput = z.output<typeof accrueInput>;

const sourceOf = (input: AccrueInput): { kind: "invoice" | "receipt" | "advance"; id: string } =>
  input.source === "invoice" ? { kind: "invoice", id: input.invoiceId } : input.source === "receipt" ? { kind: "receipt", id: input.paymentId } : { kind: "advance", id: input.applicationId };

interface OpenBase { id: string; invoice_id: string; invoice_date: string; plan_id: string; payee_party_id: string; payee_kind: PayeeKind; cost_center_id: string | null; commission: string; accrued: string; reversed: string }
interface Accrual { base: OpenBase; amount: bigint }

const openBases = (ctx: ProcessContext, invoiceIds: string[], basis: CommissionBasis) => ctx.tx<OpenBase[]>`
  select id, invoice_id, invoice_date::text, plan_id, payee_party_id, payee_kind, cost_center_id, commission::text, accrued::text, reversed::text
  from sales.commission_bases
  where company_id = ${ctx.companyId} and invoice_id = any(${invoiceIds}::uuid[]) and basis = ${basis} and status = 'open'
  order by invoice_id, seq for update`;

/** What each open base earns from the source (zero amounts left out). */
async function accrualsOf(ctx: ProcessContext, input: AccrueInput): Promise<Accrual[]> {
  if (input.source === "invoice") {
    return (await openBases(ctx, [input.invoiceId], "on_invoice"))
      .map((base) => ({ base, amount: cents(base.commission) - cents(base.accrued) }))
      .filter((a) => a.amount !== ZERO);
  }
  if (input.allocations.length === 0) return [];
  const bases = await openBases(ctx, [...new Set(input.allocations.map((a) => a.invoiceId))], "on_collection");
  const remaining = new Map(bases.map((b) => [b.id, cents(b.commission) - cents(b.accrued) - cents(b.reversed)]));
  const earned = new Map<string, bigint>();
  for (const a of input.allocations) {
    const settled = cents(a.amount);
    const openAfter = cents(a.openAfterDoc);
    for (const base of bases.filter((b) => b.invoice_id === a.invoiceId)) {
      const left = remaining.get(base.id)!;
      const amount = openAfter <= ZERO ? left : settled + openAfter === ZERO ? ZERO : ratio(left, settled, settled + openAfter);
      remaining.set(base.id, left - amount);
      earned.set(base.id, (earned.get(base.id) ?? ZERO) + amount);
    }
  }
  return bases.map((base) => ({ base, amount: earned.get(base.id) ?? ZERO })).filter((a) => a.amount !== ZERO);
}

const commissionOutput = z.object({ commissionIds: z.array(z.string()) });

export const commissionAccrue = defineProcess({
  id: "sales.commission.accrue",
  module: "sales",
  kind: "create",
  // Commissions of the source document named by the event: no record of the caller's is created from the screen.
  recordAccess: "none",
  feature: FEATURE_COMMISSIONS,
  origins: ["event"],
  emits: [COMMISSION_ACCRUED],
  description:
    "Causa las comisiones de una factura (al facturar) o de un recaudo (recibo de caja o aplicación de anticipo, al recaudo): un documento por beneficiario con su asiento de gasto y cuenta por pagar; solo lo ejecutan los eventos de la factura y del pago",
  idempotencyKey: (input) => {
    const source = sourceOf(input as AccrueInput);
    return `accrue:${source.kind}:${source.id}`;
  },
  input: accrueInput,
  output: commissionOutput,
  handler: async (ctx, input) => {
    const source = sourceOf(input);
    // A redelivery after the first run committed (another key, or the key's row gone): the documentos it wrote.
    const done = await ctx.tx<{ id: string }[]>`
      select id from sales.commissions where company_id = ${ctx.companyId} and source_kind = ${source.kind} and source_id = ${source.id} and reverses_id is null order by seq`;
    if (done.length > 0) return { commissionIds: done.map((c) => c.id) };
    const accruals = await accrualsOf(ctx, input);
    if (accruals.length === 0) return { commissionIds: [] };

    const [company] = await ctx.tx<{ currency_code: string; today: string }[]>`
      select currency_code, to_char((now() at time zone coalesce(timezone, 'UTC'))::date, 'YYYY-MM-DD') as today from kernel.companies where id = ${ctx.companyId}`;
    const date = input.source === "invoice" ? accruals[0]!.base.invoice_date : input.date ?? company!.today;
    // One documento per payee and plan (the plan gives the due date), in the order the bases were written.
    const groups = new Map<string, Accrual[]>();
    for (const a of accruals) {
      const key = `${a.base.payee_party_id}:${a.base.plan_id}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    const linkKind = source.kind === "invoice" ? "invoice_to_commission" : "receipt_to_commission";
    const linkFrom = source.kind === "invoice" ? "invoicing.invoice" : source.kind === "receipt" ? "payments.receipt" : "payments.advance_application";
    const commissionIds: string[] = [];
    for (const lines of groups.values()) {
      const first = lines[0]!.base;
      const total = lines.reduce((s, l) => s + l.amount, ZERO);
      if (total === ZERO) continue;
      const [header] = await ctx.tx<{ id: string }[]>`
        insert into sales.commissions (company_id, date, due_date, payee_party_id, payee_kind, plan_id, source_kind, source_id, currency, amount, stage, requires_approval, posts)
        select ${ctx.companyId}, ${date}::date, ${date}::date + p.payment_days, ${first.payee_party_id}, ${first.payee_kind}, p.id, ${source.kind}, ${source.id},
               ${company!.currency_code.trim()}, ${fromCents(total)}, 'posted', false, true
        from sales.commission_plans p where p.id = ${first.plan_id}
        returning id`;
      const commissionId = header!.id;
      await ctx.tx`insert into sales.commission_lines ${ctx.tx(lines.map((l, i) => ({
        company_id: ctx.companyId, commission_id: commissionId, line_no: i + 1, base_id: l.base.id, cost_center_id: l.base.cost_center_id, amount: fromCents(l.amount),
      })))}`;
      const raised = lines.map((l) => ({ id: l.base.id, amount: fromCents(l.amount) }));
      await ctx.tx`
        update sales.commission_bases b set accrued = b.accrued + r.amount
        from jsonb_to_recordset(${ctx.tx.json(raised as never)}::jsonb) as r(id uuid, amount numeric)
        where b.id = r.id`;
      await linksOf(ctx).sync({ to: { entity: commissionEntity.id, id: commissionId }, kind: linkKind, from: [{ entity: linkFrom, id: source.id }] });
      // Grabar: the number (COM-, on save) and the posting (Contabiliza): the post hook emits sales.commission.accrued.
      await runLifecycle(ctx, ctx.registry.entity(commissionEntity.id), commissionId, "save");
      commissionIds.push(commissionId);
    }
    return { commissionIds };
  },
});

/** The payload of sales.commission.accrued (Task 30.2's «Interfaces · Produces»): what the rule commission-accrued posts. */
async function accruedPayload(ctx: ProcessContext, commissionId: string) {
  const [c] = await ctx.tx<{ id: string; number: string; date: string; due_date: string; payee_party_id: string; payee_kind: PayeeKind; amount: string }[]>`
    select id, number, date::text, due_date::text, payee_party_id, payee_kind, amount::text from sales.commissions where id = ${commissionId}`;
  const lines = await ctx.tx<{ base_id: string; amount: string; cost_center_id: string | null }[]>`
    select base_id, amount::text, cost_center_id from sales.commission_lines where commission_id = ${commissionId} order by line_no`;
  return {
    commissionId: c!.id,
    number: c!.number,
    date: c!.date,
    payeePartyId: c!.payee_party_id,
    payeeKind: c!.payee_kind,
    dueDate: c!.due_date,
    total: Number(c!.amount),
    lines: lines.map((l) => ({ baseId: l.base_id, amount: Number(l.amount), ...(l.cost_center_id ? { costCenterId: l.cost_center_id } : {}) })),
  };
}

/**
 * Posts `name` inline (emitAndPostStrict, in a savepoint) and, when the ledger refuses it, emits it for the posting engine instead, which records
 * the refusal as a posting failure (see the header): the commission stands, its entry waits in Pendientes.
 */
async function postOrPend(ctx: ProcessContext, name: string, payload: unknown): Promise<void> {
  try {
    await ctx.tx.savepoint((sp) => emitAndPostStrict({ ...ctx, tx: sp as unknown as ProcessContext["tx"] }, name, payload, { requireRule: true }));
  } catch (error) {
    if (!(error instanceof ProcessError)) throw error;
    await ctx.emit(name, payload);
  }
}

/**
 * The lifecycle hooks of a commission: numbered COM- on save from the company counter; the generic Grabar changes no data of it (a commission
 * changes only through the sales.commission processes); its post step emits sales.commission.accrued (Task 30.2).
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
  async post(ctx, record) {
    await postOrPend(ctx, COMMISSION_ACCRUED, await accruedPayload(ctx, record.id));
  },
};

// =============================================================================================================================================
// The consumers (RG-12): each runs sales.commission.accrue as its own run; none reads another module's tables (rule 3).

const due = z.looseObject({ invoiceId: id, basis: z.enum(["on_collection", "on_invoice"]) });
const collected = z.looseObject({
  paymentId: id.optional(),
  applicationId: id.optional(),
  date: z.iso.date().optional(),
  allocations: z.array(z.looseObject({ invoiceId: id, amount, openAfterDoc: amount.optional() })).default([]),
});

/** Consumer of sales.commission.due: an invoice whose bases were written under on_invoice accrues them now; under on_collection, nothing. */
export const onCommissionDue: EventConsumer = async (ctx, payload) => {
  const parsed = due.safeParse(payload);
  if (!parsed.success) throw new ProcessError("invalid_input", `sales.commission.due payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  if (parsed.data.basis !== "on_invoice") return;
  await ctx.runProcess("sales.commission.accrue", { source: "invoice", invoiceId: parsed.data.invoiceId });
};

/** The allocations of a payments event that settle an invoice with open on_collection bases (a cheap read: most receipts have none). */
async function withBases(ctx: Parameters<EventConsumer>[0], allocations: { invoiceId: string; amount: number; openAfterDoc?: number }[]) {
  if (allocations.length === 0) return [];
  const ids = [...new Set(allocations.map((a) => a.invoiceId))];
  const rows = await ctx.sql<{ invoice_id: string }[]>`
    select distinct invoice_id from sales.commission_bases
    where company_id = ${ctx.companyId} and invoice_id = any(${ids}::uuid[]) and basis = 'on_collection' and status = 'open'`;
  const open = new Set(rows.map((r) => r.invoice_id));
  return allocations.filter((a) => open.has(a.invoiceId)).map((a) => {
    // An event written before Task 30.1 has no open balance: payments sends it since; without it the allocation cannot be prorated.
    if (a.openAfterDoc === undefined) throw new ProcessError("invalid_input", `allocation to ${a.invoiceId} has no openAfterDoc`);
    return { invoiceId: a.invoiceId, amount: a.amount, openAfterDoc: a.openAfterDoc };
  });
}

const collectionConsumer = (source: "receipt" | "advance"): EventConsumer => async (ctx, payload) => {
  const parsed = collected.safeParse(payload);
  const name = source === "receipt" ? "payments.received" : "payments.advance.applied";
  if (!parsed.success) throw new ProcessError("invalid_input", `${name} payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  const docId = source === "receipt" ? parsed.data.paymentId : parsed.data.applicationId ?? parsed.data.paymentId;
  if (!docId) throw new ProcessError("invalid_input", `${name} payload names no document`);
  const allocations = await withBases(ctx, parsed.data.allocations);
  if (allocations.length === 0) return;
  const date = parsed.data.date ? { date: parsed.data.date } : {};
  await ctx.runProcess("sales.commission.accrue", source === "receipt"
    ? { source, paymentId: docId, ...date, allocations }
    : { source, applicationId: docId, ...date, allocations });
};

/** Consumer of payments.received: a receipt's collection of invoices with commission bases on_collection. */
export const onPaymentReceived: EventConsumer = collectionConsumer("receipt");
/** Consumer of payments.advance.applied: an advance applied to invoices collects them like a receipt. */
export const onAdvanceApplied: EventConsumer = collectionConsumer("advance");

export const COMMISSION_PROCESSES = [commissionCompute, commissionConsultAll, commissionAccrue];
