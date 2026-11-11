import { GENERIC_VERBS, genericProcess, ProcessError, runLifecycle, type EntityDef, type GenericVerb, type ProcessContext, type ProcessDef } from "@erp/kernel";
import { refuseDuplicate, rejectErrors } from "./common";

// The accounting maestros and comprobantes on the typed-entity lifecycle (entity types spec 2026-11-02 §5, §10.2; Phase 2A.5 Task 8b).
// The kernel's generic processes (`<entity>.save|submit|approve|reject|void|delete`) run the lifecycle; accounting declares them
// itself (a module's own id wins) so that the checks the lifecycle cannot know run around it: a reference that must exist before the
// row is written (a Fuente, a parent node), a duplicate key refused as the create and update processes refuse it, the comprobante's
// own refusals and columns (Eliminar, Enviar a aprobación, No Aprobar). The validation itself is the entity's `typedHooks.validate`
// (typed-hooks.ts), so the generic Grabar, the update processes and Aprobar run the same checks. The helpers mirror core's (Task 8a):
// accounting does not import core's code (the dependency is the published views and events only, rule 3).

type Lifecycle = { status: "saved" | "pending"; requires_approval: boolean };

/**
 * The state and Requiere aprobación of a maestro its create process writes (spec §10.2): Grabado, or Pendiente de Aprobación when the
 * company requires approval of the entity (kernel.entity_type_settings, Parámetros). Written explicitly, so the flag and the state agree.
 */
export async function initialLifecycle(ctx: ProcessContext, entityId: string): Promise<Lifecycle> {
  const [row] = await ctx.tx<{ requires_approval: boolean }[]>`
    select requires_approval from kernel.entity_type_settings where company_id = ${ctx.companyId} and entity = ${entityId}`;
  const requires = row?.requires_approval === true;
  return { status: requires ? "pending" : "saved", requires_approval: requires };
}

/**
 * What an update process of a maestro does after writing its columns: the record follows the lifecycle as if saved with Grabar
 * (Borrador and No Aprobado become Grabado, Pendiente and Aprobado stay; the validate hook runs). D10: an Aprobado record that
 * requires approval goes back to Pendiente when one of its approval fields changed. `before` is the row as the update read it.
 */
export async function followLifecycle(ctx: ProcessContext, entityId: string, recordId: string, before: Record<string, unknown>): Promise<void> {
  const entity = ctx.registry.entity(entityId);
  const { status } = await runLifecycle(ctx, entity, recordId, "save");
  if (status !== "approved" || before.requires_approval !== true) return;
  const [after] = await ctx.tx`select * from ${ctx.tx(entity.schema)}.${ctx.tx(entity.table)} where id = ${recordId}`;
  const changed = (entity.typed?.approvalFields ?? []).some((name) => JSON.stringify(before[name] ?? null) !== JSON.stringify(after?.[name] ?? null));
  if (changed) await runLifecycle(ctx, entity, recordId, "submit");
}

export type LifecycleInput = { id: string; data?: Record<string, unknown>; reason?: string; expectedUpdatedAt?: string };
type Result = { id: string; status: string; number?: string; deleted?: true };

export interface LifecycleOptions {
  /** Runs before the verb (after the input is parsed): refusals the row write would otherwise turn into a database error. */
  before?: Partial<Record<GenericVerb, (ctx: ProcessContext, input: LifecycleInput) => Promise<void>>>;
  /** Runs after the verb, in the same transaction: the entity's own columns and events. */
  after?: Partial<Record<GenericVerb, (ctx: ProcessContext, input: LifecycleInput, result: Result) => Promise<void>>>;
  /** Grabar's unique key: a violation is refused as `invalid_input` with the detail. */
  duplicate?: { constraint: string; detail(data: Record<string, unknown>): string };
  /**
   * The columns Grabar's `data` may carry (those of the record's update process). Refused before the row is written, so a foreign
   * key in a refused column fails as a refusal, not as a database error; the validate hook checks the same set again.
   */
  writable?: ReadonlySet<string>;
  /** Tool descriptions (es-419) that replace the kernel's generic ones. */
  descriptions?: Partial<Record<GenericVerb, string>>;
}

/** The six generic processes of `entity`, in `feature`, with the module's checks around them. */
export function lifecycleProcesses(entity: EntityDef, feature: string, options: LifecycleOptions = {}): ProcessDef[] {
  return GENERIC_VERBS.map((verb) => {
    const generic = genericProcess(entity, verb);
    const handler = async (ctx: ProcessContext, input: LifecycleInput) => {
      if (verb === "save" && options.writable) assertWritable(generic.id, input.data, options.writable);
      await options.before?.[verb]?.(ctx, input);
      const run = () => generic.handler(ctx, input) as Promise<Result>;
      const { duplicate } = options;
      const result = verb === "save" && duplicate ? await refuseDuplicate(generic.id, duplicate.constraint, duplicate.detail(input.data ?? {}), run) : await run();
      await options.after?.[verb]?.(ctx, input, result);
      return result;
    };
    const description = options.descriptions?.[verb];
    return { ...generic, feature, handler, ...(description ? { description } : {}) } as ProcessDef;
  });
}

/** Refuses with invalid_input every key of Grabar's `data` outside `allowed`: what the record's update process does not write. */
export function assertWritable(processId: string, data: Record<string, unknown> | undefined, allowed: ReadonlySet<string>): void {
  const refused = Object.keys(data ?? {}).filter((name) => !allowed.has(name));
  rejectErrors(processId, refused.map((name) => `El campo ${name} no se puede modificar con Grabar`));
}

/**
 * Refuses, before the row is written, a reference in Grabar's `data` that does not exist in the company: without it the foreign key
 * would fail as a database error instead of a refusal the screen can show. `refs` maps a column to its table and the noun.
 */
export async function assertRefsExist(ctx: ProcessContext, data: Record<string, unknown> | undefined, refs: Record<string, { table: string; noun: string }>): Promise<void> {
  for (const [column, ref] of Object.entries(refs)) {
    const value = data?.[column];
    if (value === undefined || value === null) continue;
    const valid = typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    const [row] = valid
      ? await ctx.tx`select 1 from ${ctx.tx(ref.table)} where id = ${value} and company_id = ${ctx.companyId} and deleted_at is null`
      : [];
    if (!row) throw new ProcessError("invalid_input", `${column} ${String(value)} not found`, { details: [`No existe ${ref.noun} indicado`] });
  }
}
