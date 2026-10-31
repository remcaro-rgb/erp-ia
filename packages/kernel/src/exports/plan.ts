import type { Sql } from "postgres";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import { buildQuery } from "../query/build-query";
import { EXTRA_PREFIX, type GridStateInput } from "../query/grid-state";
import { gridEntity, requireGridAccess } from "../query/access";
import { applyGridParams, gridAccess, visibleIn, type GridAccess } from "../query/run";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { exportColumns, selectColumns, type ExportPresentation } from "./columns";
import { ROW_KEYS, type GroupedSpec } from "./grouped";
import { isoDay } from "./format";
import { groupRowsOf } from "../query/run";
import { EXPORT_PAGE_SIZE, type ExportColumn, type ExportFormat, type ExportRow } from "./types";

// What an export reads (design §9, rules 14 and 20): the grid's own query builder over the masked view `v_<table>`
// under the caller's claims, with the columns the caller may see, over the whole filter. Used by the process (to
// count), by the route (inline files) and by the workflow (jobs), so all three agree on the columns and the rows.

/** What an export is asked for: the grid state of the screen plus its presentation. */
export interface ExportSpec extends ExportPresentation {
  entity: string;
  format: ExportFormat;
  state: GridStateInput;
  title?: string;
}

export interface ExportPlan {
  entity: ResolvedEntityDef;
  columns: ExportColumn[];
  access: GridAccess;
  /** The company's legal name (the PDF's heading), when the caller can read it. */
  company: string | null;
  /** Rows of the whole filter. */
  total: number;
  /** Present when the state has `groupBy`: the subtotals and the grand total the file prints (grouped.ts). */
  grouped?: GroupedSpec;
  /** The `groupBy` fields (empty when not grouped). */
  groupFields: string[];
  /** The grid params of the state (`erp.param.*`), which every page's transaction sets before it reads. */
  params?: Record<string, string>;
  /** The select of rows `offset`..`offset + limit` (parameters included). */
  page(offset: number, limit: number): { sql: string; params: unknown[] };
}

/**
 * Resolves what the caller may export of `spec.entity` and counts the rows, in the caller's transaction. Throws
 * `ProcessError`: `invalid_input` for an unknown entity or no exportable column, `not_entitled` and `forbidden` as the
 * grid would; and `QueryError` for a state the grid would refuse (a hidden field filtered, an unknown column).
 */
export async function planExport(tx: Tx, registry: Registry, spec: ExportSpec): Promise<ExportPlan> {
  const entity = gridEntity(registry, spec.entity);
  if (!entity) throw new ProcessError("invalid_input", `unknown entity ${spec.entity}`, { details: [`La entidad ${spec.entity} no existe`] });
  await requireGridAccess(tx, registry, entity);
  const params = spec.state.params;
  await applyGridParams(tx, entity, params);
  const access = await gridAccess(tx, entity);
  const columns = exportColumns(entity, access, spec.state, spec);
  if (columns.length === 0) throw new ProcessError("invalid_input", `${spec.entity}: no exportable columns`, { details: ["No hay columnas visibles para exportar"] });

  // A masked column prints ••••••: its values are not even read.
  const fetched = selectColumns(columns.filter((c) => !c.masked));
  // Grouped (accounting design §5.14): lines come ordered by the group fields; the file adds each group's subtotal and
  // the grand total, one per chosen function over the money columns it may print.
  const groupFields = typeof spec.state.groupBy === "string" ? [spec.state.groupBy] : [...(spec.state.groupBy ?? [])];
  const fns = [...new Set((spec.state.aggregates ?? []).map((a) => a.fn))];
  const valueFields = groupFields.length > 0 ? columns.filter((c) => c.type === "money" && !c.masked).map((c) => c.field) : [];
  const aggregates = valueFields.flatMap((field) => (fns.length > 0 ? fns : (["sum"] as const)).map((fn) => ({ field, fn })));
  const state = { ...spec.state, columns: [...new Set([...fetched, ...groupFields])], aggregates: groupFields.length > 0 && aggregates.length > 0 ? aggregates : undefined };
  const extras = Object.fromEntries(access.extras.map((e) => [e.key, e.type]));
  const visible = visibleIn(access);
  const build = (window?: { offset: number; limit: number }) => buildQuery(entity, state, visible, { extras, timeZone: access.timeZone, ...(window ? { window } : {}) });

  const counted = build();
  const [count] = await tx.unsafe<{ total: number }[]>(counted.countSql, counted.params as never[]);
  let grouped: GroupedSpec | undefined;
  if (groupFields.length > 0) {
    const [grand] = counted.aggregateSql ? await tx.unsafe<Record<string, unknown>[]>(counted.aggregateSql, counted.params as never[]) : [{}];
    const raw = counted.groupAggregateSql ? await tx.unsafe<Record<string, unknown>[]>(counted.groupAggregateSql, counted.params as never[]) : [];
    grouped = {
      fields: counted.groupFields ?? groupFields,
      groups: groupRowsOf(raw, counted.groupFields ?? groupFields),
      grand: { ...grand },
      fns: fns.length > 0 ? fns : ["sum"],
      valueFields,
      labelOf: (field, value) => (value instanceof Date ? isoDay(value) : (spec.values?.[field]?.[String(value)] ?? (value === null || value === undefined ? "" : String(value)))),
    };
  }
  const [company] = await tx<{ legal_name: string }[]>`select legal_name from kernel.companies where id = kernel.current_company_id()`;
  return {
    entity,
    columns,
    access,
    company: company?.legal_name ?? null,
    total: count?.total ?? 0,
    ...(grouped ? { grouped } : {}),
    groupFields,
    ...(params ? { params } : {}),
    page(offset, limit) {
      const q = build({ offset, limit });
      return { sql: q.sql, params: q.params };
    },
  };
}

/** A database row keyed by export column: admin-defined values come out of the row's `extra` document. */
function flatten(row: Record<string, unknown>, columns: readonly ExportColumn[], groupFields: readonly string[] = []): ExportRow {
  const extra = typeof row.extra === "object" && row.extra !== null ? (row.extra as Record<string, unknown>) : {};
  const out: ExportRow = {};
  for (const column of columns) out[column.field] = column.field.startsWith(EXTRA_PREFIX) ? extra[column.field.slice(EXTRA_PREFIX.length)] : row[column.field];
  if (groupFields.length > 0) out[ROW_KEYS] = Object.fromEntries(groupFields.map((f) => [f, row[f]]));
  return out;
}

/**
 * The rows of the plan, every page of the filter, read `EXPORT_PAGE_SIZE` at a time in a transaction of their own
 * under the caller's claims (row-level security and masking apply to each page). Stops reading when the consumer does.
 */
export async function* exportRows(sql: Sql, claims: JwtClaims, plan: ExportPlan): AsyncGenerator<ExportRow> {
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const { sql: text, params } = plan.page(offset, EXPORT_PAGE_SIZE);
    const page = await withClaims(sql, claims, async (tx) => {
      await applyGridParams(tx, plan.entity, plan.params);
      return tx.unsafe<Record<string, unknown>[]>(text, params as never[]);
    });
    for (const row of page) yield flatten(row, plan.columns, plan.groupFields);
    if (page.length < EXPORT_PAGE_SIZE) return;
  }
}
