import type { JSONValue } from "postgres";
import { customData } from "../custom-fields/record";
import { extraFree } from "../custom-fields/schemas";
import type { ExtraData } from "../custom-fields/types";
import type { ProcessContext } from "../process/context";
import { ProcessError } from "../process/errors";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { entityModuleOf, IDENTIFIER, type ResolvedFieldDef } from "../registry/fields";
import { canEditData, nextStatus, type LifecycleAction, type LifecycleFlags, type RecordStatus } from "./lifecycle";
import { SYSTEM_USER_ID } from "../events/consumers";
import { writeSnapshot } from "./snapshot";

// The lifecycle runner (entity types spec 2026-11-02 §5, §8, D1–D3, D9, D10): applies the transition table of ./lifecycle to a
// real row of a maestro or documento, inside the process transaction of runProcess (one transaction: the data, the status, the
// number, the snapshot and the audit commit or roll back together). The generic processes of ./processes call it; a module adds
// its rules through `ModuleDef.typedHooks` (the kernel never names a module, rule 4). Automatic posting (D8) runs in the same
// action and transaction. Record rights (Task 9): modify / delete / void are checked by runProcess before the generic process runs
// (assertRecordRight), use here on every referenced maestro. Every status the record enters is an outbox event
// `<entity>.status_changed` (Task 12: the state e-mails of spec §7 consume it), written in the same transaction.

/** A record as the hooks receive it: the stored row (every column) after the step's changes. */
export type TypedRecord = Record<string, unknown> & { id: string; status: RecordStatus };

/** What a module plugs into the lifecycle of one of its maestros or documentos. Each hook runs in the process transaction, as the caller. */
export interface TypedHooks {
  /**
   * Refuses the step by throwing (a `ProcessError`, usually `invalid_input`): at every Grabar (`save`), at Aprobar (`approve`), at
   * posting (`post`). It may also write the columns the module derives from the record (e.g. a DIAN status), in the same transaction.
   * `change` tells what the step changed: `previous` is the row as it was locked, before the step; `data` the fields the caller gave
   * to Grabar (only on `save`).
   */
  validate?(ctx: ProcessContext, record: TypedRecord, mode: "save" | "approve" | "post", change: TypedChange): Promise<void>;
  /**
   * The document's number (D9), asked once: on the first Grabar when the entity numbers `on_save`, at posting when it numbers
   * `on_post` (comprobantes). Stored in the entity's `number` field.
   */
  number?(ctx: ProcessContext, record: TypedRecord): Promise<string>;
  /**
   * Posts the document (D8): called on Grabar (Contabiliza, no approval) or Aprobar (Contabiliza and approval), in the action's
   * transaction, after the `<entity>.ready_to_post` outbox event. It refuses by throwing (the accounting convention: `invalid_input`
   * whose message leads with the code, e.g. `period_closed: …`); the error reaches the caller unchanged and runProcess rolls the
   * whole action back. A documento whose record posts and whose module registers no post hook fails closed.
   */
  post?(ctx: ProcessContext, record: TypedRecord): Promise<void>;
}

/** What a lifecycle step changed, for the validate hook. */
export interface TypedChange {
  /** The row as it was before the step (locked, every column). */
  previous: TypedRecord;
  /** The fields given to Grabar, by field name (`save` only). */
  data?: Record<string, unknown>;
}

export interface LifecycleInput {
  /** `save` only: the fields to change, by field name (`extra` is merged under the company's custom-field rules). */
  data?: unknown;
  /** The reason of a No Aprobar (`reject`) or an Anular (`void`); required for both. */
  reason?: string;
  /** The `updated_at` the caller read; a row changed since then is refused with `stale_record`. */
  expectedUpdatedAt?: string;
}

export interface LifecycleResult {
  status: RecordStatus;
  /** The number the step gave the document, when it gave one. */
  number?: string;
  /** The record's `updated_at` after the step (ISO), for the next step's `expectedUpdatedAt`. Absent when the step removed it. */
  updatedAt?: string;
  /** Set when the step removed the record (Eliminar): hard for a documento in Borrador, soft (`deleted_at`) for a maestro. */
  deleted?: true;
}

type Typed = "maestro" | "documento";

/** Columns the lifecycle and the database own: never in `data`. */
const SYSTEM_COLUMNS = new Set([
  "id", "seq", "company_id", "created_at", "created_by", "updated_at", "updated_by",
  "status", "requires_approval", "posts", "deleted_at", "void_reason",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The hooks the entity's module registered for it (none when it registered none). */
export function typedHooksOf(registry: Registry, entity: ResolvedEntityDef): TypedHooks {
  return registry.hasModule(entity.module) ? (registry.module(entity.module).typedHooks?.[entity.id] ?? {}) : {};
}

/**
 * Applies `action` to record `recordId` of the maestro or documento `entity`, in `ctx.tx`. The row is locked first
 * (`select … for update`) and then compared with `expectedUpdatedAt`, so two people acting on the same version cannot lose an
 * update: the second waits for the first and is refused with `stale_record` (Review Focus 3).
 *
 * Refusals: `not_found` (no such record, or a deleted maestro), `stale_record`, `invalid_state` with `details: { from, action }`
 * (the status does not allow the action or a data change, D3; a referenced maestro adds `reason: "referenced"` and the i18n key
 * of the hint to set Activo = no), `invalid_input` (an unknown, system or ill-typed field in `data`, a missing reason, a hook's
 * refusal). A documento past Borrador gets one snapshot per data change or transition (§8); a maestro gets none.
 *
 * Automatic posting (D8, spec §5.2): when the record posts (`posts`), Grabar without approval and Aprobar with approval continue,
 * in the same transaction and with no savepoint: the step's own status (`saved` / `approved`, its number and snapshot), then the
 * outbox event `<entity>.ready_to_post`, `validate(…, "post")`, the number when the entity numbers `on_post`, the module's `post`
 * hook, and the status `posted` with its snapshot. Any refusal on the way propagates as thrown, so runProcess rolls the whole action
 * back: the document keeps its previous state and data, and no number, snapshot or outbox row survives. There is no partial result.
 */
export async function runLifecycle(ctx: ProcessContext, entity: ResolvedEntityDef, recordId: string, action: LifecycleAction, input: LifecycleInput = {}): Promise<LifecycleResult> {
  const type = typedOf(entity);
  for (const part of [entity.schema, entity.table]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
  const table = `${entity.schema}.${entity.table}`;
  const hooks = typedHooksOf(ctx.registry, entity);

  const current = await lockRecord(ctx, entity, type, recordId, input.expectedUpdatedAt);
  const from = current.status;
  const flags: LifecycleFlags = { requiresApproval: current.requires_approval === true, posts: current.posts === true };
  const refuse = (what: LifecycleAction, extra: Record<string, unknown> = {}) =>
    new ProcessError("invalid_state", `${entity.id} ${recordId}: ${what} is not allowed in status ${from}`, { details: { from, action: what, ...extra } });

  if (action === "post") {
    // Posting is not a step of its own: it follows Grabar or Aprobar inside the same action (D8, Task 6).
    throw refuse("post");
  }

  if (action === "delete") {
    if (nextStatus(type, from, "delete", flags) !== "deleted") throw refuse("delete");
    if (type === "documento") {
      // D1: only a Borrador (never numbered) is deleted, header and lines; the row triggers audit both.
      if (entity.typed?.lines) {
        const lines = ctx.registry.entity(entity.typed.lines.entity);
        const parent = entity.typed.lines.parentField;
        for (const part of [lines.schema, lines.table, parent]) if (!IDENTIFIER.test(part)) throw new Error(`entity ${lines.id}: invalid identifier "${part}"`);
        await ctx.tx.unsafe(`delete from ${lines.schema}.${lines.table} where ${parent} = $1`, [recordId]);
      }
      await ctx.tx.unsafe(`delete from ${table} where id = $1`, [recordId]);
    } else {
      // §10.2: a maestro's Eliminar is soft, and refused while any registered reference points at it.
      if (await isReferenced(ctx, entity, recordId)) throw refuse("delete", { reason: "referenced", messageKey: "errors.record_referenced" });
      await ctx.tx.unsafe(`update ${table} set deleted_at = now() where id = $1`, [recordId]);
    }
    return { status: from, deleted: true };
  }

  const next = nextStatus(type, from, action, flags);
  if (next === null || next === "deleted") throw refuse(action);
  let target: RecordStatus = next;

  const set: Record<string, unknown> = {};
  let dataChanged = false;
  if (action === "save" && input.data !== undefined) {
    // D3 first: a status that allows no data change refuses the data as invalid_state, whatever the data holds.
    if (!canEditData(type, from) && !isEmptyObject(input.data)) throw refuse("save");
    Object.assign(set, await dataChanges(ctx, entity, type, current, input.data));
    dataChanged = Object.keys(set).length > 0;
  }

  if (action === "reject" || action === "void") {
    if (!input.reason?.trim()) throw new ProcessError("invalid_input", `${entity.id}: ${action} needs a reason`, { details: [{ path: ["reason"], message: "Indica el motivo" }] });
    if (action === "void") set.void_reason = input.reason.trim();
  }
  if (target !== from) set.status = target;

  if (Object.keys(set).length > 0) await ctx.tx`update ${ctx.tx(entity.schema)}.${ctx.tx(entity.table)} set ${ctx.tx(set)} where id = ${recordId}`;
  let record = await readRecord(ctx, table, recordId);

  const given = action === "save" && typeof input.data === "object" && input.data !== null ? (input.data as Record<string, unknown>) : undefined;
  if (action === "save" && hooks.validate) await hooks.validate(ctx, record, "save", { previous: current, ...(given ? { data: given } : {}) });
  // D10: a change to an approval-relevant field of an approved maestro sends it back through approval. Compared once the validate
  // hook has normalized the record (the stored values before and after the step), so a value written another way is no change.
  if (action === "save" && type === "maestro" && from === "approved" && target === "approved" && flags.requiresApproval && nextStatus(type, from, "submit", flags) === "pending") {
    if (hooks.validate) record = await readRecord(ctx, table, recordId);
    if ((entity.typed?.approvalFields ?? []).some((name) => !sameValue(record[name], current[name]))) {
      await ctx.tx.unsafe(`update ${table} set status = 'pending' where id = $1`, [recordId]);
      target = "pending";
      record = { ...record, status: target };
    }
  }
  if (action === "approve" && hooks.validate) await hooks.validate(ctx, record, "approve", { previous: current });
  // Task 7: a documento may only reference usable maestros, on Grabar and Aprobar (and again at posting, below).
  if (type === "documento" && (action === "save" || action === "approve")) await assertReferencesUsable(ctx, entity, record);

  let number: string | undefined;
  const giveNumber = async (when: "on_save" | "on_post") => {
    if (!hooks.number) throw new Error(`entity ${entity.id} numbers ${when} but its module registers no number hook`);
    if (!entity.fields.some((f) => f.name === "number")) throw new Error(`entity ${entity.id} numbers ${when} but has no number field`);
    number = await hooks.number(ctx, record);
    await ctx.tx.unsafe(`update ${table} set number = $1 where id = $2`, [number, recordId]);
    record = { ...record, number };
  };
  if (action === "save" && type === "documento" && from === "draft" && target === "saved" && entity.typed?.numbering === "on_save") await giveNumber("on_save");

  // §8: every data change or transition of a documento once it is past Borrador.
  if (type === "documento" && target !== "draft" && (dataChanged || target !== from || number !== undefined)) {
    await writeSnapshot(ctx, entity, recordId, target, action === "reject" || action === "void" ? input.reason!.trim() : null);
  }

  // Task 12 (spec §7): entering a status is an event, on the action's chain and in its transaction (a refused action leaves none).
  if (target !== from) await emitStatusChanged(ctx, entity, record, from, target);

  // D8: Contabiliza posts on Grabar (no approval) or Aprobar (approval), in this transaction; a refusal rolls the action back.
  if (type === "documento" && (action === "save" || action === "approve") && nextStatus(type, target, "post", flags) === "posted") {
    if (!hooks.post) throw new Error(`entity ${entity.id}: record ${recordId} posts but its module registers no post hook`);
    await assertReferencesUsable(ctx, entity, record);
    await ctx.emit(`${entity.id}.ready_to_post`, { entity: entity.id, id: recordId, status: target, number: record.number ?? null });
    if (hooks.validate) await hooks.validate(ctx, record, "post", { previous: current });
    if (entity.typed?.numbering === "on_post" && (record.number === null || record.number === undefined)) await giveNumber("on_post");
    await hooks.post(ctx, record);
    await ctx.tx.unsafe(`update ${table} set status = 'posted' where id = $1`, [recordId]);
    const before = target;
    target = "posted";
    await writeSnapshot(ctx, entity, recordId, target, null);
    await emitStatusChanged(ctx, entity, record, before, target);
  }
  const [after] = await ctx.tx.unsafe<{ updated_at: Date }[]>(`select updated_at from ${table} where id = $1`, [recordId]);
  const updatedAt = after ? new Date(after.updated_at).toISOString() : undefined;
  return { status: target, ...(number === undefined ? {} : { number }), ...(updatedAt ? { updatedAt } : {}) };
}

/** The payload of `<entity>.status_changed`: the record, the status it left and the one it entered, its number, and who acted. */
export interface StatusChangedPayload {
  entity: string;
  id: string;
  from: RecordStatus;
  to: RecordStatus;
  number: string | null;
  /** The user whose action changed the status: a state e-mail's PDF is rendered with this user's rights (Task 12). */
  actorId: string;
}

/** The event a maestro or documento writes when one of its records enters a status. */
export const statusChangedEvent = (entityId: string): string => `${entityId}.status_changed`;

/**
 * Writes `<entity>.status_changed` for a record of the maestro or documento `entity` that entered `to` from `from`, in the caller's
 * transaction (so it exists only if the change commits). The lifecycle runner calls it for every status it gives; a module that moves
 * one of its records to a lifecycle status outside the runner (accounting's posting engine, opening and year close) calls it too, so
 * the kernel keeps owning the event (rule 4). The actor is the user who caused the change: the caller, or, when the caller is the
 * system user (an event consumer), the user who started the causal chain (`causingUser`).
 */
export async function emitStatusChanged(ctx: ProcessContext, entity: ResolvedEntityDef, record: { id: string; number?: unknown }, from: RecordStatus, to: RecordStatus): Promise<void> {
  typedOf(entity);
  const number = typeof record.number === "string" ? record.number : null;
  const payload: StatusChangedPayload = { entity: entity.id, id: record.id, from, to, number, actorId: await causingUser(ctx) };
  await ctx.emit(statusChangedEvent(entity.id), payload);
}

/**
 * The person behind the run: the caller, unless it is the system user acting for an event, in which case the first person on the run's
 * causal chain (the earliest audit row of the chain, in the company, that is neither the system user nor of origin `event`). With no
 * person on the chain (a scheduler run), the system user, whose state e-mails fail closed (ruling of 2026-11-02).
 */
export async function causingUser(ctx: ProcessContext): Promise<string> {
  if (ctx.userId !== SYSTEM_USER_ID) return ctx.userId;
  const [row] = await ctx.tx<{ actor_user_id: string }[]>`
    select actor_user_id from kernel.audit_log
    where company_id = ${ctx.companyId} and chain_id = ${ctx.chainId}
      and actor_user_id is distinct from ${SYSTEM_USER_ID}::uuid and origin <> 'event'
    order by occurred_at, id limit 1`;
  return row?.actor_user_id ?? ctx.userId;
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
}

function typedOf(entity: ResolvedEntityDef): Typed {
  if (entity.entityType !== "maestro" && entity.entityType !== "documento") throw new Error(`entity ${entity.id} is not a maestro or documento`);
  return entity.entityType;
}

/** Locks the row and checks it against the version the caller read. A deleted maestro does not exist for the lifecycle. */
async function lockRecord(ctx: ProcessContext, entity: ResolvedEntityDef, type: Typed, recordId: string, expectedUpdatedAt: string | undefined): Promise<TypedRecord> {
  if (!UUID.test(recordId)) throw new ProcessError("not_found", `${entity.id} ${recordId} not found`);
  const live = type === "maestro" ? " and t.deleted_at is null" : "";
  const [row] = await ctx.tx.unsafe<{ record: TypedRecord; stale: boolean }[]>(
    `select to_jsonb(t) as record,
            ($2::timestamptz is not null and date_trunc('milliseconds', t.updated_at) is distinct from date_trunc('milliseconds', $2::timestamptz)) as stale
       from ${entity.schema}.${entity.table} t
      where t.id = $1${live}
        for update`,
    [recordId, expectedUpdatedAt ?? null],
  );
  if (!row) throw new ProcessError("not_found", `${entity.id} ${recordId} not found`);
  if (row.stale) {
    throw new ProcessError("stale_record", `${entity.id} ${recordId} changed after ${expectedUpdatedAt}`, {
      details: { expectedUpdatedAt, updatedAt: row.record.updated_at },
    });
  }
  return row.record;
}

async function readRecord(ctx: ProcessContext, table: string, recordId: string): Promise<TypedRecord> {
  const [row] = await ctx.tx.unsafe<{ record: TypedRecord }[]>(`select to_jsonb(t) as record from ${table} t where t.id = $1`, [recordId]);
  return row!.record;
}

/**
 * Whether any column of the reference registry (kernel."references") holds this record's id. Asked of `kernel.record_referenced`
 * (security definer), so a referencing row the caller's RLS hides still counts.
 */
async function isReferenced(ctx: ProcessContext, entity: ResolvedEntityDef, recordId: string): Promise<boolean> {
  const [row] = await ctx.tx<{ used: boolean }[]>`select kernel.record_referenced(${entity.id}, ${recordId}::uuid) as used`;
  return row?.used === true;
}

/**
 * The ref fields of `fields` that point at a maestro the registry knows (a ref to another entity type is not gated; an unknown entity
 * of a loaded module throws). A ref to an entity of a module that is not loaded (an optional neighbour, plan 2B Task 53.2) is skipped:
 * no gate on it, its raw id stays usable.
 */
function maestroRefs(registry: Registry, fields: ResolvedFieldDef[]): { name: string; target: string }[] {
  const out: { name: string; target: string }[] = [];
  for (const f of fields) {
    if (f.type !== "ref" || !f.ref || f.viewExpr !== undefined) continue;
    if (!registry.hasModule(entityModuleOf(f.ref.entity))) continue;
    // Fail closed: a ref to an entity a loaded module does not declare throws (registry.entity throws) rather than skipping the check.
    const target = registry.entity(f.ref.entity);
    if (target.entityType === "maestro") out.push({ name: f.name, target: target.id });
  }
  return out;
}

/**
 * The maestro usability gate (spec §5.2, D10), run on Grabar, Aprobar and the posting step: every non-null `ref` field of the
 * documento header and of its lines whose target entity is a maestro must be usable (`kernel.record_usable`: live, active, and
 * saved or, when it requires approval, approved; always of the caller's company). The first one that is not refuses the step with
 * `maestro_not_usable` and `details: { field, entity, recordId, lineId? }`; runProcess rolls the action back.
 *
 * Exported for a module's own posting paths that post a documento outside the runner (accounting's engine, opening and year close),
 * so the gate runs there in the same transaction too.
 *
 * The record-level `use` right (Task 9, spec §9.1) is checked here too, for the caller, beside the usability: a maestro the caller
 * cannot read is refused exactly as one that does not exist or is not usable (`maestro_not_usable`, same message and details), so the
 * refusal never tells that it exists; one they read but may not use is `record_forbidden` with
 * `details: { field, entity, recordId, right: "use", lineId? }`. Company admins are never narrowed (kernel.can_access_record).
 *
 * `callerRights: false` (ruling of 2026-11-02 on review I2) is for references the system chose, not the caller: the posting engine's
 * rules and mappings, the opening and the year close. Only the usability applies to them; the caller's read and use rights do not.
 * References a person picks (Grabar, Aprobar) keep the default, `true`.
 */
export async function assertReferencesUsable(ctx: ProcessContext, entity: ResolvedEntityDef, record: TypedRecord, opts: { callerRights?: boolean } = {}): Promise<void> {
  const callerRights = opts.callerRights ?? true;
  const check = async (field: string, target: string, recordId: string, lineId?: string) => {
    const [row] = callerRights
      ? await ctx.tx<{ readable: boolean; usable: boolean; allowed: boolean }[]>`
          select kernel.can_access_record(${target}, ${recordId}::uuid, 'read') as readable,
                 kernel.record_usable(${target}, ${recordId}::uuid) as usable,
                 kernel.can_access_record(${target}, ${recordId}::uuid, 'use') as allowed`
      : await ctx.tx<{ readable: boolean; usable: boolean; allowed: boolean }[]>`
          select true as readable, kernel.record_usable(${target}, ${recordId}::uuid) as usable, true as allowed`;
    const where = { field, entity: target, recordId, ...(lineId ? { lineId } : {}) };
    if (row?.readable !== true || row.usable !== true) {
      throw new ProcessError("maestro_not_usable", `${entity.id} ${record.id}: ${field} references ${target} ${recordId}, which is not usable`, { details: where });
    }
    if (row.allowed !== true) {
      throw new ProcessError("record_forbidden", `${entity.id} ${record.id}: the caller has no use right on ${target} ${recordId} (${field})`, {
        details: { ...where, right: "use" },
      });
    }
  };
  for (const ref of maestroRefs(ctx.registry, entity.fields)) {
    const value = record[ref.name];
    if (typeof value === "string") await check(ref.name, ref.target, value);
  }
  if (!entity.typed?.lines) return;
  const lines = ctx.registry.entity(entity.typed.lines.entity);
  const refs = maestroRefs(ctx.registry, lines.fields);
  if (refs.length === 0) return;
  for (const part of [lines.schema, lines.table, entity.typed.lines.parentField, ...refs.map((r) => r.name)]) {
    if (!IDENTIFIER.test(part)) throw new Error(`entity ${lines.id}: invalid identifier "${part}"`);
  }
  const rows = await ctx.tx.unsafe<Record<string, unknown>[]>(`select id, ${refs.map((r) => r.name).join(", ")} from ${lines.schema}.${lines.table} where ${entity.typed.lines.parentField} = $1 order by id`, [record.id]);
  for (const line of rows) {
    for (const ref of refs) {
      const value = line[ref.name];
      if (typeof value === "string") await check(ref.name, ref.target, value, String(line.id));
    }
  }
}

/** The columns `data` changes, checked against the entity's fields; refuses unknown, system and ill-typed ones with `invalid_input`. */
async function dataChanges(ctx: ProcessContext, entity: ResolvedEntityDef, type: Typed, current: TypedRecord, data: unknown): Promise<Record<string, unknown>> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ProcessError("invalid_input", `${entity.id}: data must be an object`, { details: [{ path: ["data"], message: "Los datos no son válidos" }] });
  }
  const fields = new Map(entity.fields.map((f) => [f.name, f]));
  const issues: { path: string[]; message: string }[] = [];
  const set: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    const field = fields.get(name);
    const numbered = type === "documento" && name === "number" && (entity.typed?.numbering ?? "none") !== "none";
    if (!field || SYSTEM_COLUMNS.has(name) || field.viewExpr !== undefined || numbered) {
      issues.push({ path: [name], message: `El campo ${name} no se puede modificar` });
      continue;
    }
    // A value equal to the stored one is no data change: it is checked, but neither updated nor snapshotted.
    if (name === "extra") {
      const custom = await customData(ctx, entity.id, current.extra as ExtraData | null, value as ExtraData);
      if (custom.errors.length > 0) issues.push(...custom.errors.map((message) => ({ path: ["extra"], message })));
      else if (!sameJson(custom.extra, current.extra ?? {})) set.extra = ctx.tx.json(custom.extra as JSONValue);
      continue;
    }
    if (name === "extra_free") {
      const parsed = extraFree.safeParse(value ?? undefined);
      if (!parsed.success) issues.push({ path: ["extra_free"], message: "Los datos adicionales libres no son válidos" });
      else if (!sameJson(parsed.data ?? [], current.extra_free ?? [])) set.extra_free = ctx.tx.json((parsed.data ?? []) as JSONValue);
      continue;
    }
    const problem = checkValue(field, value);
    if (problem) issues.push({ path: [name], message: problem });
    // A list field binds a JS array, which postgres.js sends as text[]; any other json field is jsonb.
    else if (!sameStored(field, value, current[name])) set[name] = field.type === "json" && !field.list && value !== null ? ctx.tx.json(value as JSONValue) : value;
  }
  if (issues.length > 0) throw new ProcessError("invalid_input", `invalid data for ${entity.id}`, { details: issues });
  return set;
}

/** Why `value` cannot be stored in `field`, or null. */
function checkValue(field: ResolvedFieldDef, value: unknown): string | null {
  if (value === null || value === undefined) return field.required ? `El campo ${field.name} es obligatorio` : null;
  const wrong = `El valor de ${field.name} no es válido`;
  if (field.list) {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return wrong;
    return field.type === "enum" && !value.every((v) => (field.enumValues ?? []).includes(v)) ? wrong : null;
  }
  switch (field.type) {
    case "text":
      return typeof value === "string" ? null : wrong;
    case "number":
    case "money":
      return (typeof value === "number" && Number.isFinite(value)) || (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) ? null : wrong;
    case "boolean":
      return typeof value === "boolean" ? null : wrong;
    case "date":
      return typeof value === "string" && DATE.test(value) && !Number.isNaN(Date.parse(value)) ? null : wrong;
    case "datetime":
      return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? null : wrong;
    case "enum":
      return typeof value === "string" && (field.enumValues ?? []).includes(value) ? null : wrong;
    case "uuid":
    case "ref":
      return typeof value === "string" && UUID.test(value) ? null : wrong;
    case "json":
      return null;
  }
}

/** Whether a checked value of `field` equals the stored one as `to_jsonb` reads it. */
function sameStored(field: ResolvedFieldDef, next: unknown, stored: unknown): boolean {
  if (field.type === "json" || field.list) return sameJson(next ?? null, stored ?? null);
  if (field.type === "datetime" && typeof next === "string" && typeof stored === "string") return Date.parse(next) === Date.parse(stored);
  return sameValue(next, stored);
}

/** Structural equality of two JSON values, whatever the key order (jsonb reorders object keys). */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

/** Equality of a value given in `data` and the stored one as `to_jsonb` reads it (a numeric may come as a number or a string). */
function sameValue(next: unknown, stored: unknown): boolean {
  if (JSON.stringify(next ?? null) === JSON.stringify(stored ?? null)) return true;
  const numeric = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? Number(v) : NaN);
  return !Number.isNaN(numeric(next)) && numeric(next) === numeric(stored);
}
