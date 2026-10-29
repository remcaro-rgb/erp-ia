import { z } from "zod";
import { requireAdmin } from "../admin/common";
import { loadCustomFields } from "../custom-fields/store";
import type { Tx } from "../db/client";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { recordTitles, type RecordRef } from "../records/titles";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { fieldOfKey } from "../registry/labels";
import { AUDIT_FEATURE, type AuditAction } from "./audit";

// The detail of one audit entry (design §22.13–14, rule 16): every field the entry changed with its previous and new value
// (from the row trigger's diff), the field's label from the catalogue, what a creation or a refused run received, and the
// record a clone was created from. Language-neutral: labels are i18n keys (or the admin's own label of an admin-defined
// field) and values are the stored ones; the viewer turns them into text with the shared label helper
// (registry/labels.ts). The viewer's field visibility applies here, in the database session (rule 14): a field
// `kernel.field_mode` masks for them carries no values, a hidden one is left out, and admin-defined data keeps only the
// keys `kernel.mask_extra` lets them view.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Columns every table carries that say nothing about the record's data. */
const TECHNICAL = new Set(["id", "company_id", "created_at", "updated_at", "created_by", "updated_by"]);
/** Never shown, whatever the entity declares (0025's trigger does not record them either). */
const SECRETS = new Set(["token", "secret", "password"]);
/** What runProcess records as the input of a refused run (process/run.ts): the reason and the process. */
const DENIAL_KEYS = new Set(["code", "process_id"]);

type Diff = Record<string, { old: unknown; new: unknown }>;

/** One entry as kernel.v_audit_entries publishes it to the company admin, with the row changes of its run. */
export interface AuditRecord {
  id: string;
  occurredAt: Date;
  origin: string;
  processId: string | null;
  /** As the entry names it: an entity id or a process prefix (`core.party`), or a table (`core.parties`) for a row change. */
  entity: string;
  rowId: string | null;
  action: AuditAction;
  actorUserId: string | null;
  actor: string | null;
  chainId: string;
  sourceRowId: string | null;
  input: unknown;
  /** The entry's own diff, or the merged diffs of its run's row changes of the same record (a process entry has none). */
  diff: Diff | null;
  /** The table the diff was recorded on (`<schema>.<table>`). */
  diffEntity: string | null;
}

/** What a field's value needs to be read as text and who may read it. */
interface FieldInfo {
  /** Column, or `extra.<key>` for an admin-defined field. */
  field: string;
  /** i18n key of the registry field's label; null when the entity declares none (the column name stands in). */
  labelKey: string | null;
  /** The admin's own label of an admin-defined field. */
  labelText?: string;
  type: string | null;
  valuesKey?: string;
  codes?: string;
  /** The viewer sees the field masked: its values are not given. */
  masked: boolean;
}

export type AuditFieldChange = FieldInfo & { before: unknown; after: unknown };
export type AuditInputValue = Omit<FieldInfo, "field"> & { key: string; field: string | null; value: unknown };

export interface AuditEntrySummary {
  id: string;
  occurredAt: string;
  origin: string;
  processId: string | null;
  /** The process's description from the registry (Spanish, `ProcessDef.description`); null for a direct change. */
  processDescription: string | null;
  entity: string;
  /** The registered entity the entry acts on, and its label key; null for a platform table without one. */
  entityId: string | null;
  entityLabel: string | null;
  rowId: string | null;
  /** The record's title as the viewer sees it (its display field, through the masked view); null when not seen. */
  rowTitle: string | null;
  action: AuditAction;
  actorUserId: string | null;
  actor: string | null;
  chainId: string;
  /** The record this one was cloned from (rule 37), and its title. */
  sourceRowId: string | null;
  sourceTitle: string | null;
}

export interface AuditEntryDetail {
  entry: AuditEntrySummary;
  changes: AuditFieldChange[];
  /** What a creation or a refused run received; null for any other entry. */
  input: AuditInputValue[] | null;
  /**
   * False when the entry acts on a table no registered entity declares (a platform table): its fields have no catalogue
   * and no visibility rules, so none is described (fail closed) and the viewer says so.
   */
  described: boolean;
}

/** The last name segment of an entity id: `core.product_category` → `category`, as the module names its processes. */
const shortName = (entity: ResolvedEntityDef) => entity.id.slice(entity.id.indexOf(".") + 1).split("_").at(-1)!;
const prefixOf = (processId: string) => processId.slice(0, processId.lastIndexOf("."));

/**
 * The registered entity an audit entry names, whichever way it spells it: the entity id (`core.party`), the table of a
 * row change (`core.parties`), the prefix of a process the entity declares (`core.category.create`) or of the module's
 * own naming of its processes (`core.contact.*` for `core.party_contact`). Undefined when none or more than one matches.
 */
export function auditEntityOf(registry: Registry, raw: string): ResolvedEntityDef | undefined {
  const entities = registry.entities();
  const unique = (matches: ResolvedEntityDef[]) => (matches.length === 1 ? matches[0] : undefined);
  return (
    entities.find((e) => e.id === raw) ??
    entities.find((e) => `${e.schema}.${e.table}` === raw) ??
    unique(entities.filter((e) => Object.values(e.processIds ?? {}).some((p) => p !== undefined && prefixOf(p) === raw))) ??
    unique(entities.filter((e) => `${e.module}.${shortName(e)}` === raw))
  );
}

interface Row {
  id: string;
  occurred_at: Date;
  origin: string;
  process_id: string | null;
  entity: string;
  row_id: string | null;
  action: AuditAction;
  actor_user_id: string | null;
  actor: string | null;
  chain_id: string;
  source_row_id: string | null;
  input: unknown;
  diff: Diff | null;
}

const isDiff = (value: unknown): value is Diff => typeof value === "object" && value !== null && !Array.isArray(value);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Several row changes of one record in one run, as one: each field's first previous value and last new value. */
function mergeDiffs(diffs: Diff[]): Diff {
  const merged: Diff = {};
  for (const diff of diffs) {
    for (const [field, change] of Object.entries(diff)) {
      merged[field] = field in merged ? { old: merged[field]!.old, new: change?.new ?? null } : { old: change?.old ?? null, new: change?.new ?? null };
    }
  }
  return Object.fromEntries(Object.entries(merged).filter(([, change]) => !same(change.old, change.new)));
}

/**
 * The entry `id` as the caller reads kernel.v_audit_entries (the company admin; anyone else gets null), with its diff:
 * a process entry carries none, so it takes the row changes its run made to the same record.
 */
export async function readAuditEntry(tx: Tx, id: string): Promise<AuditRecord | null> {
  if (!UUID.test(id)) return null;
  const [row] = await tx<Row[]>`
    select id, occurred_at, origin, process_id, entity, row_id, action, actor_user_id, actor, chain_id, source_row_id, input, diff
    from kernel.v_audit_entries where id = ${id}`;
  if (!row) return null;
  let diff = isDiff(row.diff) ? row.diff : null;
  let diffEntity = diff ? row.entity : null;
  if (!diff && row.row_id && row.process_id && ["insert", "update", "delete"].includes(row.action)) {
    // The run's own row changes: written in its transaction before its process entry and after the previous process
    // entry of the same process on the same record in the chain, so two runs in one chain never merge.
    // Compared in SQL: the timestamps keep their microseconds.
    const changes = await tx<{ entity: string; diff: Diff }[]>`
      with e as (select chain_id, row_id, process_id, occurred_at from kernel.v_audit_entries where id = ${row.id})
      select c.entity, c.diff from kernel.v_audit_entries c, e
      where c.chain_id = e.chain_id and c.row_id = e.row_id and c.process_id = e.process_id and c.diff is not null
        and c.occurred_at <= e.occurred_at
        and c.occurred_at > coalesce((
          select max(p.occurred_at) from kernel.v_audit_entries p
          where p.chain_id = e.chain_id and p.row_id = e.row_id and p.process_id = e.process_id and p.diff is null
            and p.occurred_at < e.occurred_at
        ), '-infinity'::timestamptz)
      order by c.occurred_at, c.id`;
    if (changes.length > 0) {
      diff = mergeDiffs(changes.map((c) => c.diff).filter(isDiff));
      diffEntity = changes[0]!.entity;
    }
  }
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    origin: row.origin,
    processId: row.process_id,
    entity: row.entity,
    rowId: row.row_id,
    action: row.action,
    actorUserId: row.actor_user_id,
    actor: row.actor,
    chainId: row.chain_id,
    sourceRowId: row.source_row_id,
    input: row.input,
    diff,
    diffEntity,
  };
}

const CUSTOM_TYPES: Record<string, string> = { number: "number", bool: "boolean", date: "date" };

/** The viewer's mode of each field of `entity` (kernel.field_mode: the admin sees everything). */
async function modesOf(tx: Tx, entity: ResolvedEntityDef | undefined, fields: string[]): Promise<Map<string, string>> {
  if (!entity || fields.length === 0) return new Map();
  const rows = await tx<{ field: string; mode: string }[]>`
    select f as field, kernel.field_mode(${entity.id}, f) as mode from unnest(${fields}::text[]) as f`;
  return new Map(rows.map((r) => [r.field, r.mode]));
}

/** What the declared field `fieldName` of `entity` needs to be read. */
function infoOf(entity: ResolvedEntityDef, fieldName: string, masked: boolean): FieldInfo {
  const field = entity.fields.find((f) => f.name === fieldName)!;
  return {
    field: field.name,
    labelKey: field.label,
    type: field.type,
    ...(field.valuesKey ? { valuesKey: field.valuesKey } : {}),
    ...(field.codes ? { codes: field.codes } : {}),
    masked,
  };
}

/** Admin-defined data as the viewer may see it: only the keys kernel.mask_extra keeps, with the admin's labels. */
async function visibleExtra(tx: Tx, entity: ResolvedEntityDef, values: unknown[]): Promise<{ values: Record<string, unknown>[]; fields: Map<string, { label: string; type: string }> }> {
  const objects = values.map((v) => (isDiff(v) ? v : {}));
  const rows = await tx<{ masked: Record<string, unknown> | null }[]>`
    select kernel.mask_extra(${entity.id}, v.value) as masked from jsonb_array_elements(${tx.json(objects as never)}::jsonb) with ordinality as v(value, n) order by v.n`;
  const definitions = await loadCustomFields(tx, entity.id);
  return {
    values: rows.map((r) => r.masked ?? {}),
    fields: new Map(definitions.map((d) => [d.key, { label: d.label, type: d.type }])),
  };
}

const extraInfo = (key: string, definition: { label: string; type: string } | undefined): FieldInfo => ({
  field: `extra.${key}`,
  labelKey: null,
  labelText: definition?.label ?? key,
  type: CUSTOM_TYPES[definition?.type ?? ""] ?? "text",
  masked: false,
});

const empty = (value: unknown) => value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

/**
 * The changed fields and the input of `record` as the caller may see them (their field visibility, in `tx`). Fail closed:
 * only the fields the registered entity declares (not the technical ones, never a `token`, `secret` or `password`),
 * admin-defined data per key, masked fields without values, hidden ones left out; an entry on a table no entity declares
 * describes nothing (`described: false`). The input is given for a creation (`insert`: its declared fields) and a refused
 * run (`denied`: the reason and the process).
 */
export async function describeAuditEntry(tx: Tx, registry: Registry, record: AuditRecord): Promise<Pick<AuditEntryDetail, "changes" | "input" | "described">> {
  const changedEntity = auditEntityOf(registry, record.diffEntity ?? record.entity);
  const inputEntity = auditEntityOf(registry, record.entity) ?? changedEntity;
  const denied = record.action === "denied";
  const described = (record.diff ? changedEntity : inputEntity) !== undefined;
  const shown = (name: string) => !TECHNICAL.has(name) && !SECRETS.has(name);

  const diff = changedEntity ? (record.diff ?? {}) : {};
  const changedColumns = Object.keys(diff).filter((c) => shown(c) && changedEntity!.fields.some((f) => f.name === c));

  const rawInput = (record.action === "insert" && inputEntity) || denied ? (isDiff(record.input) ? (record.input as Record<string, unknown>) : null) : null;
  const inputs: [string, unknown, ResolvedEntityDef["fields"][number] | undefined][] = [];
  for (const [key, value] of Object.entries(rawInput ?? {})) {
    if (empty(value)) continue;
    if (denied) {
      if (DENIAL_KEYS.has(key)) inputs.push([key, value, undefined]);
      continue;
    }
    const field = fieldOfKey(inputEntity!.fields, key);
    if (field && shown(field.name)) inputs.push([key, value, field]);
  }

  const changeModes = await modesOf(tx, changedEntity, changedColumns);
  const inputFields = inputs.flatMap(([, , field]) => (field ? [field.name] : []));
  const inputModes = inputEntity === changedEntity ? new Map(changeModes) : new Map<string, string>();
  for (const [field, mode] of await modesOf(tx, inputEntity, inputFields.filter((f) => !inputModes.has(f)))) inputModes.set(field, mode);

  const changes: AuditFieldChange[] = [];
  for (const column of changedColumns) {
    const mode = changeModes.get(column) ?? "visible";
    if (mode === "hidden") continue;
    const info = infoOf(changedEntity!, column, mode === "masked");
    const change = diff[column]!;
    if (column === "extra" && !info.masked) {
      const { values, fields } = await visibleExtra(tx, changedEntity!, [change.old, change.new]);
      const [before, after] = values as [Record<string, unknown>, Record<string, unknown>];
      for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
        if (!same(before[key], after[key])) changes.push({ ...extraInfo(key, fields.get(key)), before: before[key] ?? null, after: after[key] ?? null });
      }
      continue;
    }
    changes.push({ ...info, before: info.masked ? null : (change.old ?? null), after: info.masked ? null : (change.new ?? null) });
  }

  let input: AuditInputValue[] | null = null;
  if (rawInput) {
    input = [];
    for (const [key, value, field] of inputs) {
      if (!field) {
        input.push({ key, field: null, labelKey: null, type: null, masked: false, value });
        continue;
      }
      const mode = inputModes.get(field.name) ?? "visible";
      if (mode === "hidden") continue;
      const { field: name, ...info } = infoOf(inputEntity!, field.name, mode === "masked");
      if (name === "extra" && !info.masked && isDiff(value)) {
        const { values, fields } = await visibleExtra(tx, inputEntity!, [value]);
        for (const [extraKey, extraValue] of Object.entries(values[0]!)) {
          const { field: extraField, ...extra } = extraInfo(extraKey, fields.get(extraKey));
          if (!empty(extraValue)) input.push({ key: `${key}.${extraKey}`, field: extraField, ...extra, value: extraValue });
        }
        continue;
      }
      input.push({ key, field: name, ...info, value: info.masked ? null : value });
    }
  }
  return { changes, input, described };
}

/** The process that wrote the entry, when the registry still knows it. */
function processDescription(registry: Registry, processId: string | null): string | null {
  if (!processId) return null;
  try {
    return registry.process(processId).description;
  } catch {
    return null;
  }
}

/** The whole detail of `record` for the caller: the entry with its names and titles, its changes and its input. */
export async function auditEntryDetail(tx: Tx, registry: Registry, record: AuditRecord): Promise<AuditEntryDetail> {
  const entity = auditEntityOf(registry, record.entity) ?? (record.diffEntity ? auditEntityOf(registry, record.diffEntity) : undefined);
  const refs: RecordRef[] = entity ? [record.rowId, record.sourceRowId].filter((id): id is string => id !== null).map((id) => ({ entity, id })) : [];
  const titles = refs.length > 0 ? await recordTitles(tx, registry, refs) : new Map<string, string | null>();
  const titleOf = (id: string | null) => (entity && id ? (titles.get(`${entity.id}:${id}`) ?? null) : null);
  return {
    entry: {
      id: record.id,
      occurredAt: record.occurredAt.toISOString(),
      origin: record.origin,
      processId: record.processId,
      processDescription: processDescription(registry, record.processId),
      entity: record.entity,
      entityId: entity?.id ?? null,
      entityLabel: entity?.label ?? null,
      rowId: record.rowId,
      rowTitle: titleOf(record.rowId),
      action: record.action,
      actorUserId: record.actorUserId,
      actor: record.actor,
      chainId: record.chainId,
      sourceRowId: record.sourceRowId,
      sourceTitle: titleOf(record.sourceRowId),
    },
    ...(await describeAuditEntry(tx, registry, record)),
  };
}

const fieldValue = z.object({
  labelKey: z.string().nullable(),
  labelText: z.string().optional(),
  type: z.string().nullable(),
  valuesKey: z.string().optional(),
  codes: z.string().optional(),
  masked: z.boolean(),
});

export const auditEntryRead = defineProcess({
  id: "kernel.audit.entry",
  module: "kernel",
  kind: "consult",
  feature: AUDIT_FEATURE,
  description:
    "Consulta el detalle de una entrada de la auditoría (solo el administrador): cada campo que cambió con su valor anterior y el nuevo, lo que recibió una creación o un intento denegado, y el registro de origen de un duplicado, según la visibilidad de campos de quien consulta",
  input: z.object({ id: z.uuid() }),
  output: z.object({
    entry: z.object({
      id: z.string(),
      occurredAt: z.string(),
      origin: z.string(),
      processId: z.string().nullable(),
      processDescription: z.string().nullable(),
      entity: z.string(),
      entityId: z.string().nullable(),
      entityLabel: z.string().nullable(),
      rowId: z.string().nullable(),
      rowTitle: z.string().nullable(),
      action: z.enum(["insert", "update", "delete", "consult", "denied"]),
      actorUserId: z.string().nullable(),
      actor: z.string().nullable(),
      chainId: z.string(),
      sourceRowId: z.string().nullable(),
      sourceTitle: z.string().nullable(),
    }),
    changes: z.array(fieldValue.extend({ field: z.string(), before: z.unknown(), after: z.unknown() })),
    input: z.array(fieldValue.extend({ key: z.string(), field: z.string().nullable(), value: z.unknown() })).nullable(),
    described: z.boolean(),
  }),
  handler: async (ctx, { id }) => {
    // The role matrix lets the process run; administering the company is what may read its log.
    await requireAdmin(ctx);
    const record = await readAuditEntry(ctx.tx, id);
    if (!record) throw new ProcessError("not_found", `audit entry ${id} not found`);
    return auditEntryDetail(ctx.tx, ctx.registry, record);
  },
});
