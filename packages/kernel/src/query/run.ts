import type { Sql } from "postgres";
import type { CustomFieldType } from "../custom-fields/types";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import type { EntityDef } from "../registry/entities";
import { buildQuery, ROW_MASKED } from "./build-query";
import { QueryError } from "./errors";
import { EXTRA_PREFIX, type GridState } from "./grid-state";
import { addRefLabels } from "./ref-labels";
import type { Registry } from "../registry";

/** How a field reaches the caller (rule 14, `kernel.field_mode`). */
export type FieldMode = "visible" | "masked" | "hidden";

/** An admin-defined field of the entity and whether the caller's roles may view it (`roles_view`). */
export interface GridExtraField {
  key: string;
  label: string;
  type: CustomFieldType;
  options: string[] | null;
  viewable: boolean;
}

export interface GridAccess {
  /** Mode of every registry field of the entity for the caller. */
  modes: Record<string, FieldMode>;
  /** The company's custom fields of the entity. */
  extras: GridExtraField[];
  /** The company's time zone. */
  timeZone: string;
}

/** One group of a grouped grid (accounting plan, Task 6): `level` 1..n, `keys` of the first `level` group fields, `<fn>:<field>` aggregates. */
export interface GroupRow {
  level: number;
  keys: Record<string, unknown>;
  count: number;
  aggregates: Record<string, unknown>;
}

export interface GridResult {
  rows: Record<string, unknown>[];
  total: number;
  aggregates?: Record<string, unknown>;
  /** Present when the state has `groupBy`; the grand total row is not among them (`aggregates` has it). */
  groups?: GroupRow[];
}

/** The groups of the rollup rows `sql` returned: level = group fields set, the grand total (level 0) left out. */
export function groupRowsOf(raw: readonly Record<string, unknown>[], fields: readonly string[]): GroupRow[] {
  const reserved = new Set([...fields, "grouping", "count"]);
  return raw.flatMap((row) => {
    // grouping(g1, g2, g3): bit set = that field is rolled up (g1 is the highest bit).
    const rolledUp = Number(row.grouping);
    const level = fields.filter((_, i) => ((rolledUp >> (fields.length - 1 - i)) & 1) === 0).length;
    if (level === 0) return [];
    return [
      {
        level,
        keys: Object.fromEntries(fields.slice(0, level).map((f) => [f, row[f]])),
        count: Number(row.count),
        aggregates: Object.fromEntries(Object.entries(row).filter(([k]) => !reserved.has(k))),
      },
    ];
  });
}

/**
 * What the caller may see of `entity`, resolved under the caller's claims in one round trip per question: the
 * mode of each field (`kernel.field_mode`), the custom fields with `roles_view` against the caller's roles,
 * and the company's time zone.
 */
export async function gridAccess(tx: Tx, entity: EntityDef): Promise<GridAccess> {
  const names = entity.fields.map((f) => f.name);
  const modes = await tx<{ field: string; mode: FieldMode }[]>`
    select field, mode from kernel.field_modes(${entity.id}, ${names}::text[])`;
  const extras = await tx<{ key: string; label: string; type: CustomFieldType; options: string[] | null; viewable: boolean }[]>`
    select key, label, type, options, roles_view && kernel.current_role_ids() as viewable
    from kernel.custom_fields
    where entity = ${entity.id} and company_id = kernel.current_company_id()
    order by label, key`;
  const [company] = await tx<{ timezone: string }[]>`select timezone from kernel.companies where id = kernel.current_company_id()`;
  return {
    modes: Object.fromEntries(modes.map((m) => [m.field, m.mode])),
    extras: extras.map((e) => ({ ...e, viewable: e.viewable === true })),
    timeZone: company?.timezone ?? "UTC",
  };
}

/** Whether `field` (a registry field or `extra.<key>`) is shown as it is to the caller. */
export function visibleIn(access: GridAccess): (field: string) => boolean {
  return (field) => {
    if (field.startsWith(EXTRA_PREFIX)) {
      const key = field.slice(EXTRA_PREFIX.length);
      return access.modes.extra === "visible" && access.extras.some((e) => e.key === key && e.viewable);
    }
    return (access.modes[field] ?? "visible") === "visible";
  };
}

export interface GridQueryOptions {
  /**
   * Name the records the page's references point to (`<field>_label`, design §22.15, rule 21), through the target
   * entities this registry declares and the caller may read. The grid route and the assistant's query pass it; an
   * option list or a lookup's own read has no references to show and leaves it out.
   */
  registry?: Registry;
}

/**
 * Runs one grid page for the caller (design §9): resolves what they may see, builds the select over the masked
 * view and reads the rows, the total and the aggregates in one transaction under their claims, so company RLS,
 * the party scope and masking apply. Throws `QueryError` when the state uses a field the caller may not filter
 * or sort by.
 */
export async function runGridQuery(sql: Sql, claims: JwtClaims, entity: EntityDef, state: GridState, options: GridQueryOptions = {}): Promise<GridResult & { access: GridAccess }> {
  return withClaims(sql, claims, (tx) => gridQueryInTx(tx, entity, state, options));
}

const PARAM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PARAM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `value` is a well-formed value of a grid param of `type`. */
function paramFits(type: "uuid" | "date" | "text", value: string): boolean {
  if (type === "uuid") return PARAM_UUID.test(value);
  if (type === "date") {
    const m = PARAM_DATE.exec(value);
    if (!m) return false;
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  }
  return true;
}

/**
 * Sets the grid params of `state` as the transaction settings `erp.param.<name>` (local to `tx`, so they end with it) for the
 * entity's view to read. Every name must be declared in `entity.gridParams` (an entity without any refuses all) and fit its
 * type; throws `QueryError` `unknown_param` or `bad_value` otherwise, before any query runs.
 */
export async function applyGridParams(tx: Tx, entity: EntityDef, params: Record<string, string> | undefined): Promise<void> {
  const declared = new Map((entity.gridParams ?? []).map((p) => [p.name, p]));
  const given = Object.entries(params ?? {});
  for (const [name, value] of given) {
    const def = declared.get(name);
    if (!def) throw new QueryError("unknown_param", name);
    if (!paramFits(def.type, value)) throw new QueryError("bad_value", name, `${name} is not a valid ${def.type}`);
  }
  for (const def of declared.values()) if (def.required && params?.[def.name] === undefined) throw new QueryError("bad_value", def.name, `${def.name} is required`);
  for (const [name, value] of given) await tx`select set_config(${`erp.param.${name}`}, ${value}, true)`;
}

/** One grid page read in `tx` (a transaction as the caller, e.g. a process's): see `runGridQuery`. */
export async function gridQueryInTx(tx: Tx, entity: EntityDef, state: GridState, options: GridQueryOptions = {}): Promise<GridResult & { access: GridAccess }> {
  await applyGridParams(tx, entity, state.params);
  const access = await gridAccess(tx, entity);
  const extras = Object.fromEntries(access.extras.map((e) => [e.key, e.type]));
  const q = buildQuery(entity, state, visibleIn(access), { extras, timeZone: access.timeZone });
  const rows = await tx.unsafe<Record<string, unknown>[]>(q.sql, q.params as never[]);
  const [count] = await tx.unsafe<{ total: number }[]>(q.countSql, q.params as never[]);
  const result: GridResult & { access: GridAccess } = { rows: rows.map(placeholderMarked), total: count?.total ?? 0, access };
  if (options.registry) await addRefLabels(tx, options.registry, entity, result.rows);
  if (q.aggregateSql) {
    const [aggregates] = await tx.unsafe<Record<string, unknown>[]>(q.aggregateSql, q.params as never[]);
    result.aggregates = { ...aggregates };
  }
  if (q.groupAggregateSql && q.groupFields) {
    const raw = await tx.unsafe<Record<string, unknown>[]>(q.groupAggregateSql, q.params as never[]);
    result.groups = groupRowsOf(raw, q.groupFields);
  }
  return result;
}

/** A grid row as the page gets it: a «••••» placeholder row (D20) keeps `__row_masked: true`; any other row carries no marker. */
function placeholderMarked(row: Record<string, unknown>): Record<string, unknown> {
  const { [ROW_MASKED]: masked, ...rest } = row;
  return masked === true ? { ...rest, [ROW_MASKED]: true } : rest;
}

/** A role's party scope (design §5.18): which parties the caller sees (`kernel.party_scope()`). */
export type PartyScope = "ambos" | "clientes" | "proveedores" | "ninguno";

/** What a grid page needs to present the entity to the caller: the field access and the party scope. */
export async function gridPageAccess(sql: Sql, claims: JwtClaims, entity: EntityDef): Promise<GridAccess & { partyScope: PartyScope }> {
  return withClaims(sql, claims, async (tx) => {
    const access = await gridAccess(tx, entity);
    const [row] = await tx<{ scope: PartyScope | null }[]>`select kernel.party_scope() as scope`;
    return { ...access, partyScope: row?.scope ?? "ninguno" };
  });
}
