import { GENERIC_VERBS, genericProcess, ProcessError, runLifecycle, type EntityDef, type ProcessContext, type ProcessDef } from "@erp/kernel";
import { z } from "zod";

// Helpers every payments handler shares: typed refusals, the first lifecycle state of a maestro, Grabar's duplicate refusal, the company's
// today and the money text of a refusal (the same helpers each module keeps for itself: modules never import one another, rule 3).

export const id = z.uuid();
export const idInput = z.object({ id });
export const idOutput = z.object({ id: z.string() });
export const date = z.iso.date();
/** Money: up to two decimals (the ledger's cents), at most 13 integer digits. */
export const money = z.number().finite().min(0).max(1e13).refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, "Máximo dos decimales");
/** Admin-defined extra data (design §5.14); the processes validate it against the company's custom fields. */
export const extra = z.record(z.string(), z.unknown()).optional();

/** Refuses the run with `invalid_input` when there is any error; `details` lists them. */
export function rejectErrors(processId: string, errors: readonly string[]): void {
  if (errors.length > 0) throw new ProcessError("invalid_input", `invalid input for ${processId}`, { details: [...errors] });
}

/** A refusal whose message leads with its code (the accounting convention): the first detail follows the code, `details` lists every one. */
export function refuse(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_input", `${code}: ${details[0] ?? code}`, { details: [...details] });
}

/** A refusal of the record's state (invalid_state), with its code first. */
export function refuseState(code: string, details: readonly string[]): never {
  throw new ProcessError("invalid_state", `${code}: ${details[0] ?? code}`, { details: [...details] });
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

/** The company's today in its time zone. */
export async function today(ctx: ProcessContext): Promise<string> {
  const [row] = await ctx.tx<{ today: string }[]>`select (now() at time zone coalesce(timezone, 'America/Bogota'))::date::text as today from kernel.companies where id = ${ctx.companyId}`;
  return row!.today;
}

export const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
export const cents = (n: number): number => Math.round(n * 100);
export const round2 = (n: number): number => cents(n) / 100;

/** Money as the screens write it (rule 23: `$ 1.234.567,00`), for the text of a refusal. */
export function pesos(n: number): string {
  const [int, dec] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "-" : ""}$ ${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}
