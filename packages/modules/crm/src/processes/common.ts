import { GENERIC_VERBS, genericProcess, ProcessError, runLifecycle, type EntityDef, type ProcessContext, type ProcessDef, type Tx } from "@erp/kernel";
import { z } from "zod";

// Helpers every crm handler shares: typed refusals, the first lifecycle state of a maestro, Grabar's duplicate refusal and the party facts
// crm reads from core's published views (rule 3: never core's tables).

export const id = z.uuid();
export const idInput = z.object({ id });
export const idOutput = z.object({ id: z.string() });
/** Admin-defined extra data (design §5.14); the processes validate it against the company's custom fields. */
export const extra = z.record(z.string(), z.unknown()).optional();

/** Refuses the run with `invalid_input` when there is any error; `details` lists them. */
export function rejectErrors(processId: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: [...errors] });
}

/** A refusal whose message leads with its code, the accounting convention: the first detail follows the code, `details` lists every one. */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

/** Runs a write and turns a violation of the unique index `constraint` into `invalid_input` with `detail`. */
export async function refuseDuplicate<T>(processId: string, constraint: string, detail: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    const pg = error as { code?: string; constraint_name?: string };
    if (pg.code === UNIQUE_VIOLATION && pg.constraint_name === constraint) {
      throw new ProcessError("invalid_input", `duplicate in ${processId}`, { details: [detail], cause: error });
    }
    throw error;
  }
}

/** Copies `input` without the keys whose value is undefined. */
export function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}

/** Spec §10.2: Grabado, or Pendiente de Aprobación when the company requires approval of the entity (kernel.entity_type_settings). */
export async function initialLifecycle(ctx: ProcessContext, entityId: string): Promise<{ status: "saved" | "pending"; requires_approval: boolean }> {
  const [row] = await ctx.tx<{ requires_approval: boolean }[]>`
    select requires_approval from kernel.entity_type_settings where company_id = ${ctx.companyId} and entity = ${entityId}`;
  const requires = row?.requires_approval === true;
  return { status: requires ? "pending" : "saved", requires_approval: requires };
}

/** After an update process wrote its columns: the record follows Grabar's lifecycle step (the validate hook, D10). */
export async function followLifecycle(ctx: ProcessContext, entityId: string, recordId: string, before: Record<string, unknown>): Promise<void> {
  const entity = ctx.registry.entity(entityId);
  const { status } = await runLifecycle(ctx, entity, recordId, "save");
  if (status !== "approved" || before.requires_approval !== true) return;
  const [after] = await ctx.tx`select * from ${ctx.tx(entity.schema)}.${ctx.tx(entity.table)} where id = ${recordId}`;
  const changed = (entity.typed?.approvalFields ?? []).some((name) => JSON.stringify(before[name] ?? null) !== JSON.stringify(after?.[name] ?? null));
  if (changed) await runLifecycle(ctx, entity, recordId, "submit");
}

/** The six generic processes of the maestro `entity`, in `feature`; Grabar refuses a duplicate of the unique index `constraint`. */
export function maestroLifecycle(entity: EntityDef, feature: string, duplicate: { constraint: string; detail: string }): ProcessDef[] {
  return GENERIC_VERBS.map((verb) => {
    const generic = genericProcess(entity, verb);
    const handler = (ctx: ProcessContext, input: unknown) =>
      verb === "save" ? refuseDuplicate(generic.id, duplicate.constraint, duplicate.detail, () => generic.handler(ctx, input)) : generic.handler(ctx, input);
    return { ...generic, feature, handler } as ProcessDef;
  });
}

/** Refuses with invalid_input every key of Grabar's `data` outside `allowed`. */
export function assertWritable(processId: string, data: Record<string, unknown> | undefined, allowed: readonly string[]): void {
  rejectErrors(processId, Object.keys(data ?? {}).filter((name) => !allowed.includes(name)).map((name) => `El campo ${name} no se puede modificar con Grabar`));
}

/** A numeric column (a string from the driver) as a number. */
export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** A money amount: up to 14 integer and 4 decimal digits (numeric(18,4)), never negative. */
export const money = z.number().finite().min(0).refine((n) => n < 1e14, "Importe fuera de rango").refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");

/** The terceros the caller can see (core's published view, party scope and masking applied), by id. */
export async function visibleParties(ctx: ProcessContext, ids: readonly string[]): Promise<Map<string, { id: string; legalName: string | null; invoiceReady: boolean | null; dianStatus: string | null }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await ctx.tx<{ id: string; legal_name: string | null; invoice_ready: boolean | null; dian_status: string | null }[]>`
    select id, legal_name, invoice_ready, dian_status from core.v_parties where id = any(${unique}::uuid[])`;
  return new Map(rows.map((r) => [r.id, { id: r.id, legalName: r.legal_name, invoiceReady: r.invoice_ready, dianStatus: r.dian_status }]));
}

/** How many days before a document's date a rate still answers for it (a weekend, a holiday): core.exchange_rate.for_date's lookback. */
const RATE_LOOKBACK_DAYS = 3;

/**
 * The default rate of a document in `currency` on `date` (Task 34.3, FX §2, R34-2): the company's row of Tasas de cambio for that day, else
 * the latest within the 3 days before, read through core's published view core.v_exchange_rates (rule 3; a rate the caller may not see is
 * no rate). Null when there is none: the caller refuses with exchange_rate_missing unless the user typed a rate.
 */
export async function defaultRate(tx: Tx, currency: string, date: string): Promise<number | null> {
  const [row] = await tx<{ rate: string | null }[]>`
    select rate::text from core.v_exchange_rates
    where company_id = kernel.current_company_id() and currency = ${currency} and rate is not null
      and rate_date between ${date}::date - ${RATE_LOOKBACK_DAYS}::int and ${date}::date
    order by rate_date desc limit 1`;
  return row?.rate ? Number(row.rate) : null;
}

/** The refusal's detail when a foreign-currency document has no rate (FX §2). */
export const exchangeRateMissing = (currency: string, date: string): string =>
  `No hay tasa de cambio para ${currency} el ${date}; regístrala en Tasas de cambio o escríbela en el documento`;
