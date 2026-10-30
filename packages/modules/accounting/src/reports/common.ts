import { ProcessError, ReportState, type ProcessContext, type ReportResult } from "@erp/kernel";
import { z } from "zod";

// Shared machinery of the accounting reports (accounting design §5.13, §10a.5): the balances query with the restricted-accounts
// aggregation, the report parameters every statement shares, and the in-memory window (filter, sort, page, totals) the consult
// processes apply to the rows they computed. A report keeps the parents' totals and replaces the accounts the caller may not view
// by one line "Cuentas restringidas (n)" with their aggregated figures, so sumas iguales and the accounting equation still hold.

export const RESTRICTED_CODE = "🔒";
export const RESTRICTED_NAME = "report.restricted_accounts";

const optionalId = z.uuid().optional();

/** Parameters every statement shares: the dimension filters. */
export const dimensionParams = {
  costCenterId: optionalId,
  openAuxiliaryId: optionalId,
  itemId: optionalId,
  businessUnitId: optionalId,
  partyId: optionalId,
};

export const level = z.number().int().min(1).max(8).default(4);

/** Report consult input: the validated parameters and the window the grid asks for. */
export const reportInput = <P extends z.ZodObject>(params: P) => z.object({ params, state: ReportState });

export const reportOutput = z.object({ rows: z.array(z.record(z.string(), z.unknown())), total: z.number(), aggregates: z.record(z.string(), z.unknown()).optional() });

export interface PeriodBounds {
  id: string;
  number: number;
  startsOn: string;
  endsOn: string;
  fiscalYearId: string;
}

export async function periodBounds(ctx: ProcessContext, periodId: string): Promise<PeriodBounds> {
  const [row] = await ctx.tx<{ id: string; number: number; starts_on: string; ends_on: string; fiscal_year_id: string }[]>`
    select id, number, starts_on::text, ends_on::text, fiscal_year_id from accounting.periods where id = ${periodId} and company_id = ${ctx.companyId}`;
  if (!row) throw new ProcessError("invalid_input", `period ${periodId} not found`, { details: ["El período indicado no existe"] });
  return { id: row.id, number: row.number, startsOn: row.starts_on, endsOn: row.ends_on, fiscalYearId: row.fiscal_year_id };
}

/** `from` must not follow `to`. */
export function orderedRange(from: PeriodBounds, to: PeriodBounds): void {
  if (from.startsOn > to.startsOn) throw new ProcessError("invalid_input", "the range is reversed", { details: ["El período inicial no puede ser posterior al final"] });
}

export interface BalanceFilters {
  costCenterId?: string | undefined;
  openAuxiliaryId?: string | undefined;
  itemId?: string | undefined;
  businessUnitId?: string | undefined;
  partyId?: string | undefined;
}

export interface BalanceRow {
  nodeId: string | null;
  code: string;
  name: string;
  nature: "debit" | "credit" | null;
  section: string | null;
  restricted: boolean;
  /** Net (debit − credit) before `from`. */
  openingNet: number;
  debit: number;
  credit: number;
  /** Set when the query groups by cost center: the node (null: lines with none) and its code and name. */
  costCenterId?: string | null;
  costCenterCode?: string | null;
  costCenterName?: string | null;
}

export interface BalanceQuery extends BalanceFilters {
  /** First day of the range; everything before it is the opening. */
  from: string;
  to: string;
  level: number;
  includeOpening: boolean;
  includeClosing: boolean;
  /** One row per (node, cost center) instead of per node. */
  byCostCenter?: boolean;
}

const num = (value: unknown) => Number(value ?? 0);

/**
 * Balances per rollup node (the first `level` digits of each account's code, the account itself when its code is shorter):
 * the opening net before `from`, the debits and credits within the range. A node the caller may not view is flagged `restricted`;
 * the caller folds those into one line with `foldRestricted`. Entries posted and reversed count; an opening or closing entry
 * dated inside the range counts only when asked; one dated before it is always part of the opening.
 */
export async function balanceRows(ctx: ProcessContext, q: BalanceQuery): Promise<BalanceRow[]> {
  const rows = await ctx.tx<{
    node_id: string | null; code: string; name: string | null; nature: "debit" | "credit" | null; statement_section: string | null;
    restricted: boolean; opening_net: string | null; debit: string | null; credit: string | null;
    cost_center_id: string | null; cc_code: string | null; cc_name: string | null;
  }[]>`
    with src as (
      select case when length(a.code) >= ${q.level} then left(a.code, ${q.level}) else a.code end as node_code,
             case when ${q.byCostCenter === true} then l.cost_center_id end as cost_center_id,
             l.debit, l.credit, e.date, e.is_opening, e.is_closing
      from accounting.entry_lines l
      join accounting.entries e on e.id = l.entry_id
      join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date <= ${q.to}::date
        and (${q.costCenterId ?? null}::uuid is null or l.cost_center_id = ${q.costCenterId ?? null})
        and (${q.openAuxiliaryId ?? null}::uuid is null or l.open_auxiliary_id = ${q.openAuxiliaryId ?? null})
        and (${q.itemId ?? null}::uuid is null or l.item_id = ${q.itemId ?? null})
        and (${q.businessUnitId ?? null}::uuid is null or l.business_unit_id = ${q.businessUnitId ?? null})
        and (${q.partyId ?? null}::uuid is null or l.party_id = ${q.partyId ?? null})
    ),
    agg as (
      select node_code, cost_center_id,
             sum(debit - credit) filter (where date < ${q.from}::date) as opening_net,
             sum(debit) filter (where date >= ${q.from}::date and (${q.includeOpening} or not is_opening) and (${q.includeClosing} or not is_closing)) as debit,
             sum(credit) filter (where date >= ${q.from}::date and (${q.includeOpening} or not is_opening) and (${q.includeClosing} or not is_closing)) as credit
      from src group by node_code, cost_center_id
    )
    select n.id as node_id, agg.node_code as code, n.name, n.nature, n.statement_section,
           case when n.id is null then false else not accounting.can_view_account(n.id) end as restricted,
           agg.opening_net, agg.debit, agg.credit, agg.cost_center_id, cc.code as cc_code, cc.name as cc_name
    from agg left join accounting.accounts n on n.company_id = ${ctx.companyId} and n.code = agg.node_code
    left join accounting.cost_centers cc on cc.id = agg.cost_center_id
    order by agg.node_code, cc.code nulls last`;
  return rows.map((r) => ({
    nodeId: r.node_id, code: r.code, name: r.name ?? r.code, nature: r.nature, section: r.statement_section, restricted: r.restricted,
    openingNet: num(r.opening_net), debit: num(r.debit), credit: num(r.credit),
    ...(q.byCostCenter ? { costCenterId: r.cost_center_id, costCenterCode: r.cc_code, costCenterName: r.cc_name } : {}),
  }));
}

/** The restricted rows folded into one: their figures are added, the code is the lock, `count` says how many accounts it stands for. */
export function foldRestricted<T extends { restricted: boolean }>(rows: T[], zero: () => T, add: (acc: T, row: T) => void): { visible: T[]; restricted: T | null; count: number } {
  const visible = rows.filter((r) => !r.restricted);
  const hidden = rows.filter((r) => r.restricted);
  if (hidden.length === 0) return { visible, restricted: null, count: 0 };
  const folded = zero();
  for (const row of hidden) add(folded, row);
  return { visible, restricted: folded, count: hidden.length };
}

// ---- the window of a report ------------------------------------------------------------------------------------------

type GridFilter = ReportState["filters"][number];

const cell = (row: Record<string, unknown>, field: string): unknown => row[field];

function matches(row: Record<string, unknown>, f: GridFilter): boolean {
  const v = cell(row, f.field);
  const text = (x: unknown) => String(x ?? "").toLowerCase();
  const cmp = (a: unknown, b: unknown): number => {
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && a !== "" && b !== "") return na - nb;
    return String(a ?? "").localeCompare(String(b ?? ""));
  };
  switch (f.op) {
    case "eq": return String(v ?? "") === String(f.value ?? "") || (typeof v === "number" && v === Number(f.value));
    case "neq": return !matches(row, { ...f, op: "eq" });
    case "contains": return text(v).includes(text(f.value));
    case "ncontains": return !text(v).includes(text(f.value));
    case "starts": return text(v).startsWith(text(f.value));
    case "ends": return text(v).endsWith(text(f.value));
    case "gt": return cmp(v, f.value) > 0;
    case "gte": return cmp(v, f.value) >= 0;
    case "lt": return cmp(v, f.value) < 0;
    case "lte": return cmp(v, f.value) <= 0;
    case "between": return cmp(v, f.value) >= 0 && cmp(v, f.value2) <= 0;
    case "in": return Array.isArray(f.value) && f.value.map(String).includes(String(v ?? ""));
    case "nin": return !(Array.isArray(f.value) && f.value.map(String).includes(String(v ?? "")));
    case "is_null": return v === null || v === undefined || v === "";
    case "not_null": return !(v === null || v === undefined || v === "");
    default: return true;
  }
}

/** AND binds tighter than OR, as in the grids. */
function passes(row: Record<string, unknown>, filters: readonly GridFilter[]): boolean {
  if (filters.length === 0) return true;
  const groups: boolean[][] = [[]];
  filters.forEach((f, i) => {
    if (i > 0 && f.join === "or") groups.push([]);
    groups[groups.length - 1]!.push(matches(row, f));
  });
  return groups.some((g) => g.every(Boolean));
}

export interface WindowOptions {
  /** Columns whose sum over the whole filter goes to `aggregates`. */
  totals?: readonly string[];
  /** Rows that are subtotals or footers are kept out of the sums. */
  isDetail?: (row: Record<string, unknown>) => boolean;
  /** Extra aggregates the report adds (omitted lines, differences). */
  extra?: Record<string, unknown>;
}

/** Filters, sorts and pages the computed rows as the grid state asks, and sums the totals over the whole filter. */
export function windowOf(rows: Record<string, unknown>[], state: ReportState, options: WindowOptions = {}): ReportResult {
  const filtered = rows.filter((r) => passes(r, state.filters));
  if (state.sort.length > 0) {
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      for (const s of state.sort) {
        const av = cell(a, s.field);
        const bv = cell(b, s.field);
        const diff = typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
        if (diff !== 0) return s.dir === "asc" ? diff : -diff;
      }
      return 0;
    });
    filtered.splice(0, filtered.length, ...sorted);
  }
  const aggregates: Record<string, unknown> = { ...(options.extra ?? {}) };
  for (const field of options.totals ?? []) {
    aggregates[field] = filtered.filter((r) => options.isDetail?.(r) ?? true).reduce((sum, r) => sum + Number(r[field] ?? 0), 0);
  }
  const start = (state.page - 1) * state.pageSize;
  return { rows: filtered.slice(start, start + state.pageSize), total: filtered.length, aggregates };
}

/** Two decimals half away from zero, so sums of rounded cents do not drift. */
export const cents = (value: number): number => Math.round(value * 100) / 100 || 0;
