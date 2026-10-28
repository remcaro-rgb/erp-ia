import type { Sql } from "postgres";
import { withClaims, type JwtClaims, type Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import { buildQuery } from "../query/build-query";
import { EXTRA_PREFIX, type GridStateInput } from "../query/grid-state";
import { gridEntity, requireGridAccess } from "../query/access";
import { gridAccess, visibleIn, type GridAccess } from "../query/run";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";
import { exportColumns, selectColumns, type ExportPresentation } from "./columns";
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
  const access = await gridAccess(tx, entity);
  const columns = exportColumns(entity, access, spec.state, spec);
  if (columns.length === 0) throw new ProcessError("invalid_input", `${spec.entity}: no exportable columns`, { details: ["No hay columnas visibles para exportar"] });

  // A masked column prints ••••••: its values are not even read.
  const fetched = selectColumns(columns.filter((c) => !c.masked));
  const state = { ...spec.state, columns: fetched, aggregates: undefined };
  const extras = Object.fromEntries(access.extras.map((e) => [e.key, e.type]));
  const visible = visibleIn(access);
  const build = (window?: { offset: number; limit: number }) => buildQuery(entity, state, visible, { extras, timeZone: access.timeZone, ...(window ? { window } : {}) });

  const counted = build();
  const [count] = await tx.unsafe<{ total: number }[]>(counted.countSql, counted.params as never[]);
  const [company] = await tx<{ legal_name: string }[]>`select legal_name from kernel.companies where id = kernel.current_company_id()`;
  return {
    entity,
    columns,
    access,
    company: company?.legal_name ?? null,
    total: count?.total ?? 0,
    page(offset, limit) {
      const q = build({ offset, limit });
      return { sql: q.sql, params: q.params };
    },
  };
}

/** A database row keyed by export column: admin-defined values come out of the row's `extra` document. */
function flatten(row: Record<string, unknown>, columns: readonly ExportColumn[]): ExportRow {
  const extra = typeof row.extra === "object" && row.extra !== null ? (row.extra as Record<string, unknown>) : {};
  const out: ExportRow = {};
  for (const column of columns) out[column.field] = column.field.startsWith(EXTRA_PREFIX) ? extra[column.field.slice(EXTRA_PREFIX.length)] : row[column.field];
  return out;
}

/**
 * The rows of the plan, every page of the filter, read `EXPORT_PAGE_SIZE` at a time in a transaction of their own
 * under the caller's claims (row-level security and masking apply to each page). Stops reading when the consumer does.
 */
export async function* exportRows(sql: Sql, claims: JwtClaims, plan: ExportPlan): AsyncGenerator<ExportRow> {
  for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
    const { sql: text, params } = plan.page(offset, EXPORT_PAGE_SIZE);
    const page = await withClaims(sql, claims, (tx) => tx.unsafe<Record<string, unknown>[]>(text, params as never[]));
    for (const row of page) yield flatten(row, plan.columns);
    if (page.length < EXPORT_PAGE_SIZE) return;
  }
}
