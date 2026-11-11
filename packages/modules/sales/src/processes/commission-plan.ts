import { customData, defineProcess, ProcessError, runLifecycle, visibleExtra, type ProcessContext, type Tx, type TypedHooks } from "@erp/kernel";
import { z } from "zod";
import { commissionPlanEntity, PAYEE_KINDS, type PayeeKind } from "../entities";
import { readinessReasons, type Readiness } from "../readiness";
import { refuse } from "./order";

// Planes de comisión (plan 2B.2 Task 30.1, Part G design PG §5.1, §5.5; owner items 156, 163; RG-11, RG-14; migration 0156). A maestro: the
// payee (a core party, an employee or a supplier for an external agent; invoice_ready, rule 10, because the provision is a payable line with
// that party), the payee kind (employee | agent: the dimension the commission accounts map by, Task 30.2), the users whose pedidos it covers,
// a default rate and a rate per product category, its validity and the days the provision is due after its date. One active plan per user at
// a date: a plan that would overlap another active plan of one of its users is refused (commission_plan_overlap), under a lock per user, so
// two plans saved at once cannot both pass. The plan reads only what the caller sees (the record rule of 0156: a salesperson only the plans
// that list them); sales.commission.consult_all is the «all commissions» permission (an update-kind process, like sales.order.reassign:
// never among the consult processes a new role gets by default, owner 2026-11-10).

export const FEATURE_COMMISSION_PLANS = "sales.commissions";
const ENTITY = commissionPlanEntity.id;

const id = z.uuid();
const date = z.iso.date();
const rate = z.number().finite().min(0).max(100).refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
const lineInput = z.object({ categoryId: id, ratePct: rate }).strict();
const extra = z.record(z.string(), z.unknown()).optional();

const fields = {
  name: z.string().trim().min(1).max(120),
  payeePartyId: id,
  payeeKind: z.enum(PAYEE_KINDS),
  defaultRatePct: rate,
  paymentDays: z.number().int().min(0).max(365),
  validFrom: date,
  validTo: date.nullable(),
  notes: z.string().trim().max(2000).nullable(),
  isActive: z.boolean(),
  userIds: z.array(id).min(1, "Indica al menos un vendedor").max(200),
  lines: z.array(lineInput).max(500),
};

/** A plan as planFor answers it: what compute needs to freeze a base. */
export interface Plan {
  id: string;
  payeePartyId: string;
  payeeKind: PayeeKind;
  defaultRatePct: number;
  paymentDays: number;
  /** The rate of each product category the plan names. */
  rates: Map<string, number>;
}

/**
 * The active plan of `userId` at `date` (Grabado or Aprobado, Activo, valid that day), as the transaction's caller sees it; null when the
 * user has none. There is at most one: create and update refuse an overlap.
 */
export async function planFor(tx: Tx, userId: string, on: string): Promise<Plan | null> {
  const [row] = await tx<{ id: string; payee_party_id: string; payee_kind: PayeeKind; default_rate_pct: string; payment_days: number }[]>`
    select p.id, p.payee_party_id, p.payee_kind, p.default_rate_pct::text, p.payment_days
    from sales.commission_plans p join sales.commission_plan_users u on u.plan_id = p.id
    where p.company_id = kernel.current_company_id() and u.user_id = ${userId} and p.is_active and p.deleted_at is null
      and p.status in ('saved', 'approved') and p.valid_from <= ${on}::date and (p.valid_to is null or p.valid_to >= ${on}::date)
    order by p.valid_from desc, p.seq desc limit 1`;
  if (!row) return null;
  const lines = await tx<{ category_id: string; rate_pct: string }[]>`select category_id, rate_pct::text from sales.commission_plan_lines where plan_id = ${row.id}`;
  return {
    id: row.id, payeePartyId: row.payee_party_id, payeeKind: row.payee_kind, defaultRatePct: Number(row.default_rate_pct), paymentDays: row.payment_days,
    rates: new Map(lines.map((l) => [l.category_id, Number(l.rate_pct)])),
  };
}

/** The payee must be an employee or a supplier the caller sees, invoice_ready (complete and usable, rule 10, §22.22). */
async function assertPayee(ctx: ProcessContext, partyId: string): Promise<void> {
  const [party] = await ctx.tx<(Readiness & { kind: string[] | null })[]>`
    select kind, invoice_ready, is_active, dian_missing, missing_files, usable, status, requires_approval from core.v_party_sales where id = ${partyId}`;
  if (!party) refuse("invalid_party", ["El beneficiario no existe o no es visible"]);
  if (!(party.kind ?? []).some((k) => k === "employee" || k === "supplier")) refuse("invalid_party", ["El beneficiario de un plan de comisión es un empleado o un proveedor (agente externo)"]);
  if (party.invoice_ready !== true) refuse("party_not_invoice_ready", readinessReasons(party).map((r) => `El beneficiario ${r}`));
}

/** Every user must be a member of the company (sales' own definer helper of 0139, rule 3). */
async function assertMembers(ctx: ProcessContext, userIds: readonly string[]): Promise<void> {
  for (const userId of new Set(userIds)) {
    const [member] = await ctx.tx<{ ok: boolean }[]>`select sales.is_company_member(${userId}::uuid) as ok`;
    if (!member?.ok) refuse("invalid_user", ["Un vendedor del plan no pertenece a la empresa"]);
  }
}

/** Every category must exist and be visible (core's published view). */
async function assertCategories(ctx: ProcessContext, lines: readonly z.output<typeof lineInput>[]): Promise<void> {
  const ids = [...new Set(lines.map((l) => l.categoryId))];
  if (ids.length !== lines.length) refuse("duplicate_category", ["Una categoría va una sola vez en el plan"]);
  if (ids.length === 0) return;
  const found = new Set((await ctx.tx<{ id: string }[]>`select id from core.v_product_categories where id = any(${ids}::uuid[])`).map((r) => r.id));
  const missing = ids.filter((c) => !found.has(c));
  if (missing.length > 0) refuse("invalid_category", missing.map(() => "La categoría no existe o no es visible"));
}

/**
 * One active plan per user at a date (item 156): refuses when one of `userIds` is on another active, live plan whose validity overlaps
 * [validFrom, validTo]. Locks each user first (in id order, no deadlock), so concurrent saves queue. Reads every plan of the company
 * (definer helper below): a plan the caller cannot see still counts.
 */
async function assertNoOverlap(ctx: ProcessContext, planId: string | null, userIds: readonly string[], validFrom: string, validTo: string | null): Promise<void> {
  const users = [...new Set(userIds)].sort();
  for (const userId of users) await ctx.tx`select pg_advisory_xact_lock(hashtextextended(${`sales.commission_plan:${ctx.companyId}:${userId}`}, 0))`;
  const clashes = await ctx.tx<{ user_id: string; name: string; valid_from: string; valid_to: string | null }[]>`
    select user_id, name, valid_from::text, valid_to::text from sales.commission_plan_overlaps(${planId}::uuid, ${users}::uuid[], ${validFrom}::date, ${validTo}::date)`;
  if (clashes.length > 0) {
    refuse("commission_plan_overlap", clashes.map((c) => `El vendedor ya tiene el plan activo «${c.name}» del ${c.valid_from}${c.valid_to ? ` al ${c.valid_to}` : " en adelante"}: un vendedor tiene un solo plan activo en cada fecha`));
  }
}

async function writeChildren(ctx: ProcessContext, planId: string, userIds: readonly string[] | undefined, lines: readonly z.output<typeof lineInput>[] | undefined): Promise<void> {
  if (userIds) {
    const wanted = [...new Set(userIds)];
    await ctx.tx`delete from sales.commission_plan_users where plan_id = ${planId} and not (user_id = any(${wanted}::uuid[]))`;
    await ctx.tx`insert into sales.commission_plan_users ${ctx.tx(wanted.map((u) => ({ company_id: ctx.companyId, plan_id: planId, user_id: u })))} on conflict (plan_id, user_id) do nothing`;
  }
  if (lines) {
    await ctx.tx`delete from sales.commission_plan_lines where plan_id = ${planId}`;
    if (lines.length > 0) {
      await ctx.tx`insert into sales.commission_plan_lines ${ctx.tx(lines.map((l) => ({ company_id: ctx.companyId, plan_id: planId, category_id: l.categoryId, rate_pct: l.ratePct })))}`;
    }
  }
}

async function validExtra(ctx: ProcessContext, processId: string, stored: Record<string, unknown> | null, given: Record<string, unknown> | undefined) {
  if (given === undefined) return {};
  const custom = await customData(ctx, ENTITY, stored, given);
  if (custom.errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: custom.errors });
  return { extra: ctx.tx.json(custom.extra as Parameters<typeof ctx.tx.json>[0]) };
}

const planOutput = z.object({ id: z.string() });

export const commissionPlanCreate = defineProcess({
  id: "sales.commission_plan.create",
  module: "sales",
  kind: "create",
  feature: FEATURE_COMMISSION_PLANS,
  description:
    "Crea un plan de comisión: el beneficiario (un empleado o un agente externo, con sus datos DIAN completos), los vendedores cuyos pedidos cubre, el porcentaje general y por categoría de producto, la vigencia y los días de pago de la provisión; un vendedor tiene un solo plan activo en cada fecha",
  input: z.object({
    ...fields,
    paymentDays: fields.paymentDays.default(30),
    validTo: fields.validTo.optional(),
    notes: fields.notes.optional(),
    isActive: fields.isActive.default(true),
    lines: fields.lines.default([]),
    extra,
  }).strict(),
  output: planOutput,
  handler: async (ctx, input) => {
    if (input.validTo && input.validTo < input.validFrom) refuse("invalid_dates", ["La vigencia termina antes de empezar"]);
    await assertPayee(ctx, input.payeePartyId);
    await assertMembers(ctx, input.userIds);
    await assertCategories(ctx, input.lines);
    if (input.isActive) await assertNoOverlap(ctx, null, input.userIds, input.validFrom, input.validTo ?? null);
    const [settings] = await ctx.tx<{ requires_approval: boolean }[]>`
      select requires_approval from kernel.entity_type_settings where company_id = ${ctx.companyId} and entity = ${ENTITY}`;
    const requires = settings?.requires_approval === true;
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into sales.commission_plans ${ctx.tx({
        company_id: ctx.companyId,
        name: input.name,
        payee_party_id: input.payeePartyId,
        payee_kind: input.payeeKind,
        default_rate_pct: input.defaultRatePct,
        payment_days: input.paymentDays,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
        notes: input.notes ?? null,
        is_active: input.isActive,
        status: requires ? "pending" : "saved",
        requires_approval: requires,
        ...(await validExtra(ctx, "sales.commission_plan.create", null, input.extra)),
      })}
      returning id`;
    await writeChildren(ctx, row!.id, input.userIds, input.lines);
    return { id: row!.id };
  },
});

export const commissionPlanUpdate = defineProcess({
  id: "sales.commission_plan.update",
  module: "sales",
  kind: "update",
  feature: FEATURE_COMMISSION_PLANS,
  description:
    "Cambia un plan de comisión: el beneficiario, los vendedores, los porcentajes, la vigencia, los días de pago o si está activo; las bases ya calculadas conservan la tasa con que se calcularon",
  input: z.object(fields).partial().extend({ id, extra, expectedUpdatedAt: z.iso.datetime({ offset: true }).optional() }).strict(),
  output: planOutput,
  handler: async (ctx, { id: planId, extra: given, expectedUpdatedAt, ...input }) => {
    const [current] = await ctx.tx<Record<string, unknown>[]>`select * from sales.commission_plans where id = ${planId} and deleted_at is null for update`;
    if (!current) throw new ProcessError("not_found", `sales.commission_plan ${planId} not found`);
    if (expectedUpdatedAt && new Date(current.updated_at as string).getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ProcessError("stale_record", `sales.commission_plan ${planId} changed since it was read`);
    }
    const iso = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : (v as string | null));
    const validFrom = input.validFrom ?? iso(current.valid_from)!;
    const validTo = input.validTo !== undefined ? input.validTo : iso(current.valid_to);
    if (validTo && validTo < validFrom) refuse("invalid_dates", ["La vigencia termina antes de empezar"]);
    if (input.payeePartyId) await assertPayee(ctx, input.payeePartyId);
    if (input.userIds) await assertMembers(ctx, input.userIds);
    if (input.lines) await assertCategories(ctx, input.lines);
    const active = input.isActive ?? (current.is_active as boolean);
    if (active) {
      const users = input.userIds ?? (await ctx.tx<{ user_id: string }[]>`select user_id from sales.commission_plan_users where plan_id = ${planId}`).map((u) => u.user_id);
      await assertNoOverlap(ctx, planId, users, validFrom, validTo);
    }
    const set = Object.fromEntries(Object.entries({
      name: input.name, payee_party_id: input.payeePartyId, payee_kind: input.payeeKind, default_rate_pct: input.defaultRatePct, payment_days: input.paymentDays,
      valid_from: input.validFrom, valid_to: input.validTo, notes: input.notes, is_active: input.isActive,
    }).filter(([, v]) => v !== undefined));
    const extraSet = await validExtra(ctx, "sales.commission_plan.update", current.extra as Record<string, unknown> | null, given);
    if (Object.keys(set).length > 0 || extraSet.extra) await ctx.tx`update sales.commission_plans set ${ctx.tx({ ...set, ...extraSet })} where id = ${planId}`;
    await writeChildren(ctx, planId, input.userIds, input.lines);
    // Grabar's lifecycle step (the validate hook): a Borrador is grabado; an approved plan stays approved.
    if (current.status === "draft" || current.status === "rejected") await runLifecycle(ctx, ctx.registry.entity(ENTITY), planId, "save");
    return { id: planId };
  },
});

export const commissionPlanConsult = defineProcess({
  id: "sales.commission_plan.consult",
  module: "sales",
  kind: "consult",
  feature: FEATURE_COMMISSION_PLANS,
  description: "Consulta un plan de comisión con sus vendedores y los porcentajes por categoría (los porcentajes solo si el rol puede verlos)",
  input: z.object({ id }).strict(),
  output: z.looseObject({ id: z.string(), userIds: z.array(z.string()), lines: z.array(z.object({ categoryId: z.string(), ratePct: z.number().nullable() })) }),
  handler: async (ctx, { id: planId }) => {
    const [row] = await ctx.tx`select * from sales.v_commission_plans where id = ${planId}`;
    if (!row) throw new ProcessError("not_found", `sales.commission_plan ${planId} not found`);
    const users = await ctx.tx<{ user_id: string }[]>`select user_id from sales.commission_plan_users where plan_id = ${planId} order by seq`;
    const lines = await ctx.tx<{ category_id: string; rate_pct: string | null }[]>`select category_id, rate_pct::text from sales.v_commission_plan_lines where plan_id = ${planId} order by created_at, id`;
    return {
      ...row,
      id: planId,
      extra: await visibleExtra(ctx, ENTITY, row.extra),
      userIds: users.map((u) => u.user_id),
      lines: lines.map((l) => ({ categoryId: l.category_id, ratePct: l.rate_pct === null ? null : Number(l.rate_pct) })),
    };
  },
});

/** What the generic Grabar may change of a plan: nothing but its extra data (the plan changes through sales.commission_plan.update). */
const WRITABLE = ["extra", "extra_free"];

export const commissionPlanHooks: TypedHooks = {
  async validate(_ctx, _record, mode, { data }) {
    if (mode !== "save" || !data) return;
    const refused = Object.keys(data).filter((name) => !WRITABLE.includes(name));
    if (refused.length > 0) throw new ProcessError("invalid_input", "invalid input for sales.commission_plan.save", { details: refused.map((name) => `El campo ${name} se cambia con «Editar plan», no con Grabar`) });
  },
};

export const COMMISSION_PLAN_PROCESSES = [commissionPlanCreate, commissionPlanUpdate, commissionPlanConsult];
