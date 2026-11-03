import { ProcessError, ReportState, type ProcessContext, type ReportResult } from "@erp/kernel";
import { z } from "zod";

// Shared machinery of the accounting reports (accounting design §5.13, §10a.5): the balances query with the restricted-accounts
// aggregation, the report parameters every statement shares, and the in-memory window (filter, sort, page, totals) the consult
// processes apply to the rows they computed. A report keeps the parents' totals and replaces the accounts the caller may not view
// by one line "Cuentas restringidas (n)" with their aggregated figures, so sumas iguales and the accounting equation still hold.

export const RESTRICTED_CODE = "🔒";
export const RESTRICTED_NAME = "report.restricted_accounts";
/** The name of the lock line that stands for parties a record rule hides from the caller (D11). */
export const RESTRICTED_PARTIES = "report.restricted_parties";

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
 *
 * Record-level access (entity types spec D11, Phase 2A.5 Task 9): the amounts and the nodes come from `accounting.ledger_sums`, a
 * grouped security-definer aggregate of the caller's company only (0046), so a comprobante or a cuenta a record rule hides
 * from the caller still counts in every total; a node the caller cannot read is `restricted` too and folded, never named.
 */
export async function balanceRows(ctx: ProcessContext, q: BalanceQuery): Promise<BalanceRow[]> {
  // The grouped aggregate of 0046 (D11): every comprobante counts whoever looks; a node the caller cannot read has no id, code or name.
  const rows = await ctx.tx<{
    node_id: string | null; node_code: string | null; name: string | null; nature: "debit" | "credit" | null; statement_section: string | null;
    restricted: boolean; opening_net: string | null; debit: string | null; credit: string | null; cost_center_id: string | null;
    cc_code: string | null; cc_name: string | null;
  }[]>`
    select s.node_id, s.node_code, s.name, s.nature, s.statement_section, s.restricted, s.opening_net, s.debit, s.credit, s.cost_center_id,
           cc.code as cc_code, cc.name as cc_name
    from accounting.ledger_sums(${q.from}::date, ${q.to}::date, ${q.level}, ${q.byCostCenter === true}, ${q.costCenterId ?? null}::uuid,
                                ${q.openAuxiliaryId ?? null}::uuid, ${q.itemId ?? null}::uuid, ${q.businessUnitId ?? null}::uuid, ${q.partyId ?? null}::uuid,
                                ${q.includeOpening}, ${q.includeClosing}) s
    left join accounting.cost_centers cc on cc.id = s.cost_center_id
    order by s.node_code nulls last, cc.code nulls last`;
  return rows.map((r) => ({
    nodeId: r.node_id, code: r.node_code ?? RESTRICTED_CODE, name: r.name ?? r.node_code ?? RESTRICTED_NAME, nature: r.nature, section: r.statement_section,
    restricted: r.restricted, openingNet: num(r.opening_net), debit: num(r.debit), credit: num(r.credit),
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
