import { GENERIC_VERBS, genericProcess, runLifecycle, type EntityDef, type ProcessContext, type ProcessDef } from "@erp/kernel";
import { refuseDuplicate, rejectErrors } from "./common";

// The core maestros on the typed-entity lifecycle (entity types spec 2026-11-02 §5; Task 8a). The kernel's generic processes
// (`<entity>.save|submit|approve|reject|void|delete`) run the lifecycle; core declares them itself (a module's own id wins) so that
// a guard the lifecycle cannot know runs first (the party scope) and a duplicate key is refused as the create and update processes
// refuse it. The validation itself is the entity's `typedHooks.validate` (index.ts), so the generic Grabar, the update processes
// and Aprobar all run the same checks. The create processes write the first state: a new core maestro is created by its first Grabar.

type Lifecycle = { status: "saved" | "pending"; requires_approval: boolean };

/**
 * The state and Requiere aprobación of a record the create process writes (spec §10.2): Grabado, or Pendiente de Aprobación when the
 * company requires approval of the entity (kernel.entity_type_settings, Parámetros). Written explicitly, so the flag on the row and the
 * state agree whatever the column defaults are.
 */
export async function initialLifecycle(ctx: ProcessContext, entityId: string): Promise<Lifecycle> {
  const [row] = await ctx.tx<{ requires_approval: boolean }[]>`
    select requires_approval from kernel.entity_type_settings where company_id = ${ctx.companyId} and entity = ${entityId}`;
  const requires = row?.requires_approval === true;
  return { status: requires ? "pending" : "saved", requires_approval: requires };
}

/**
 * What an update process does after writing its columns: the record follows the lifecycle as if it had been saved with Grabar. The
 * kernel runner moves Borrador and No Aprobado to Grabado, keeps Pendiente and Aprobado, and runs the entity's validate hook (its
 * DIAN status, events…). D10: when the record was Aprobado and requires approval, a change to one of its approval fields sends it
 * back to Pendiente de Aprobación (`submit`). `before` is the row as the update read it (`select *`).
 */
export async function followLifecycle(ctx: ProcessContext, entityId: string, recordId: string, before: Record<string, unknown>): Promise<void> {
  const entity = ctx.registry.entity(entityId);
  const { status } = await runLifecycle(ctx, entity, recordId, "save");
  if (status !== "approved" || before.requires_approval !== true) return;
  const [after] = await ctx.tx`select * from ${ctx.tx(entity.schema)}.${ctx.tx(entity.table)} where id = ${recordId}`;
  const changed = (entity.typed?.approvalFields ?? []).some((name) => JSON.stringify(before[name] ?? null) !== JSON.stringify(after?.[name] ?? null));
  if (changed) await runLifecycle(ctx, entity, recordId, "submit");
}

export interface LifecycleOptions {
  /** Runs before every verb with the record id (the party scope: `writableParty`). */
  guard?(ctx: ProcessContext, recordId: string): Promise<void>;
  /** Grabar's unique key: a violation is refused as `invalid_input` with the detail, read before the write. */
  duplicate?: { constraint: string; detail(ctx: ProcessContext, recordId: string, data: Record<string, unknown>): Promise<string> };
}

type Parsed = { id: string; data?: Record<string, unknown> };

/** The six generic processes of the maestro `entity`, in `feature`, with the module's guard and duplicate refusal. */
export function lifecycleProcesses(entity: EntityDef, feature: string, options: LifecycleOptions = {}): ProcessDef[] {
  return GENERIC_VERBS.map((verb) => {
    const generic = genericProcess(entity, verb);
    const handler = async (ctx: ProcessContext, input: Parsed) => {
      await options.guard?.(ctx, input.id);
      const { duplicate } = options;
      if (verb !== "save" || !duplicate) return generic.handler(ctx, input);
      const detail = await duplicate.detail(ctx, input.id, input.data ?? {});
      return refuseDuplicate(generic.id, duplicate.constraint, detail, () => generic.handler(ctx, input));
    };
    return { ...generic, feature, handler } as ProcessDef;
  });
}

/**
 * The entries of `columns` whose value differs from the stored record (as the lifecycle runner reads it, `to_jsonb`): what a
 * validate hook must write back, so an unchanged record gets no update (no audit row, no new updated_at).
 */
export function changedColumns(record: Record<string, unknown>, columns: Record<string, unknown>): Record<string, unknown> {
  const same = (a: unknown, b: unknown) => {
    if (JSON.stringify(a ?? null) === JSON.stringify(b ?? null)) return true;
    const n = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : NaN);
    return !Number.isNaN(n(a)) && n(a) === n(b);
  };
  return Object.fromEntries(Object.entries(columns).filter(([name, value]) => !same(value, record[name])));
}

/** The column of an input key (`taxResponsibilities` → `tax_responsibilities`). */
const column = (key: string) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * The columns the generic Grabar of a maestro may write: those of its update process's input (`fields`, camelCase keys) and
 * `is_active` (reactivating; deactivating is refused by the hooks). Everything else the record carries (a balance, the DIAN status
 * and missing data, invoice readiness, a check digit, the tax override: values the module derives) stays out of reach.
 */
export function writableColumns(fields: Record<string, unknown>, ...more: string[]): ReadonlySet<string> {
  return new Set([...Object.keys(fields).map(column), "is_active", ...more]);
}

/** Refuses with invalid_input every key of Grabar's `data` outside `allowed` (see writableColumns). */
export function assertWritable(processId: string, data: Record<string, unknown> | undefined, allowed: ReadonlySet<string>): void {
  const refused = Object.keys(data ?? {}).filter((name) => !allowed.has(name));
  rejectErrors(processId, refused.map((name) => `El campo ${name} no se puede modificar con Grabar`));
}
