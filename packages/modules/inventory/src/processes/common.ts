import { GENERIC_VERBS, genericProcess, ProcessError, runLifecycle, type EntityDef, type ProcessContext, type ProcessDef } from "@erp/kernel";
import { z } from "zod";

// Helpers every inventory handler shares: typed refusals, the first lifecycle state of a maestro, Grabar's duplicate refusal and the
// product facts inventory reads from core's published view (rule 3: never core's tables).

export const id = z.uuid();
export const idInput = z.object({ id });
export const idOutput = z.object({ id: z.string() });
/** A quantity: up to 14 integer and 4 decimal digits (numeric(18,4)). */
export const quantity = z.number().finite().refine((n) => Math.abs(n) < 1e14, "Cantidad fuera de rango").refine((n) => Math.abs(Math.round(n * 1e4) - n * 1e4) < 1e-6, "Máximo cuatro decimales");
/** An entity id (`sales.delivery`): the source a movement line or a reservation answers to. */
export const entityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "Entidad de origen no válida");
/** Admin-defined extra data (design §5.14); the processes validate it against the company's custom fields. */
export const extra = z.record(z.string(), z.unknown()).optional();

/** Refuses the run with `invalid_input` when there is any error; `details` lists them. */
export function rejectErrors(processId: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: [...errors] });
}

/**
 * A refusal whose message leads with its code, the accounting convention (the engine and the consumers read the code from it): the
 * first detail follows the code, `details` lists every one.
 */
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

/**
 * The state and Requiere aprobación a create process writes on a maestro (spec §10.2): Grabado, or Pendiente de Aprobación when the
 * company requires approval of the entity (kernel.entity_type_settings, Parámetros).
 */
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

/** What inventory knows of a product, from core's published core.v_product_stock (migration 0067). */
export interface ProductFacts {
  id: string;
  sku: string;
  kind: "good" | "service";
  trackStock: boolean;
  uomCode: string;
  categoryId: string | null;
}

/** The facts of the products the caller can see, by id (a product of another company or out of reach is absent). */
export async function productFacts(ctx: ProcessContext, ids: readonly string[]): Promise<Map<string, ProductFacts>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.tx<{ id: string; sku: string; kind: "good" | "service"; track_stock: boolean; uom_code: string; category_id: string | null; standard_cost: string | null }[]>`
    select id, sku, kind, track_stock, uom_code, category_id, standard_cost from core.v_product_stock where id = any(${[...new Set(ids)]}::uuid[])`;
  return new Map(rows.map((r) => [r.id, { id: r.id, sku: r.sku, kind: r.kind, trackStock: r.track_stock, uomCode: r.uom_code, categoryId: r.category_id }]));
}

/**
 * The cost of products in a bodega, for valuing an adjustment: the weighted average costing publishes for the bodega
 * (costing.average_costs, migrations 0073/0075, plan 2B Task 8; nothing when costing is switched off), else the standard cost (core.product_standard_costs, migration 0072). Both are
 * read unmasked, so an adjustment is valued the same whatever the caller's field visibility (rule 14 governs display, not computation).
 * Absent = the product has no cost. The average is costing's as of now: a movement whose event costing has not valued yet is not in it.
 */
export async function productCosts(ctx: ProcessContext, ids: readonly string[], warehouseId: string): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const unique = [...new Set(ids)];
  const standard = await ctx.tx<{ id: string; standard_cost: string | null }[]>`select id, standard_cost from core.product_standard_costs(${unique}::uuid[])`;
  const average = await ctx.tx<{ product_id: string; avg_cost: string }[]>`select product_id, avg_cost from costing.average_costs(${warehouseId}, ${unique}::uuid[])`;
  const costs = new Map(standard.flatMap((r) => (r.standard_cost === null ? [] : [[r.id, Number(r.standard_cost)] as const])));
  for (const r of average) costs.set(r.product_id, Number(r.avg_cost));
  return costs;
}

/** A numeric column (a string from the driver) as a number. */
export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));

/** A quantity as people read it: es-CO, up to four decimals. */
export const qtyText = (n: number): string => n.toLocaleString("es-CO", { maximumFractionDigits: 4 });

/**
 * The id of a movement a process just posted. A movement a process posts without source lines is always new and saved; one that is not
 * (`voided` when a redelivery finds the movement its source already undid, `skipped` when nothing moved) is refused rather than reported
 * as done, so a transfer or an adjustment never claims stock it did not move.
 */
export function savedMovementId(posted: { id: string | null; status: "saved" | "voided" | "skipped" }, what: string): string {
  if (posted.status !== "saved" || !posted.id) {
    refuse("movement_not_posted", [posted.status === "voided" ? `${what}: el movimiento ya fue anulado` : `${what}: no movió existencias`]);
  }
  return posted.id;
}
