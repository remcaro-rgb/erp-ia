import { countryPack, type Tx } from "@erp/kernel";
import { DIMENSION_DEFS, DIMENSIONS, type Dimension } from "../dimensions";
import { RESTRICTED_CODE, RESTRICTED_NAME } from "../reports/common";
import { INCOME_SECTIONS } from "../reports/income-statement";

// The figures the record pages show (accounting design §8, Task 28): the Saldos of a Cuenta per period, and for a node of an
// analytic dimension the Saldos por cuenta and the Resultados per period, descendants included. Like the tree pane, a restricted account
// the caller may not view is neither a row nor part of a figure (§5.13); a record or an account a record rule hides from the caller
// still counts (D11, Task 9 review I1): the amounts come from `v_account_balances` and the descendants from `accounting.master_tree`
// (0046), and an account the caller cannot read is one unnamed line.

export interface PeriodRef {
  id: string;
  number: number;
  year: number;
  startsOn: string;
  status: string;
}

export interface AccountBalanceRow {
  periodId: string;
  debit: number;
  credit: number;
  /** The balance at the end of the period, signed by the account's nature, from the first period on. */
  balance: number;
}

export interface AccountBalances {
  periods: PeriodRef[];
  rows: AccountBalanceRow[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Every period of the company, oldest first. */
export async function listPeriods(tx: Tx, companyId: string): Promise<PeriodRef[]> {
  const rows = await tx<{ id: string; number: number; year: number; starts_on: string; status: string }[]>`
    select p.id, p.number, y.year, p.starts_on::text, p.status
    from accounting.v_periods p join accounting.v_fiscal_years y on y.id = p.fiscal_year_id
    where p.company_id = ${companyId} order by p.starts_on`;
  return rows.map((r) => ({ id: r.id, number: r.number, year: r.year, startsOn: r.starts_on, status: r.status }));
}

/**
 * The movement of an account and its descendants in every period, with the running balance. Null when the caller may not view the
 * account (it is not in `v_accounts`): the tab then answers "Sin acceso".
 */
export async function accountBalances(tx: Tx, input: { companyId: string; accountId: string }): Promise<AccountBalances | null> {
  const [account] = await tx<{ code: string; nature: "debit" | "credit" }[]>`
    select code, nature from accounting.v_accounts where id = ${input.accountId} and company_id = ${input.companyId}`;
  if (!account) return null;
  const [periods, sums] = await Promise.all([
    listPeriods(tx, input.companyId),
    tx<{ period_id: string; debit: string; credit: string }[]>`
      with recursive tree as (select id, parent_id from accounting.master_tree('account')),
      below as (
        select id from tree where id = ${input.accountId}
        union
        select t.id from tree t join below b on t.parent_id = b.id
      )
      select b.period_id, sum(b.debit) as debit, sum(b.credit) as credit
      from accounting.v_account_balances b
      where b.company_id = ${input.companyId} and b.account_id in (select id from below)
      group by b.period_id`,
  ]);
  const byPeriod = new Map(sums.map((s) => [s.period_id, s]));
  let running = 0;
  const rows = periods.map((p) => {
    const debit = Number(byPeriod.get(p.id)?.debit ?? 0);
    const credit = Number(byPeriod.get(p.id)?.credit ?? 0);
    running += debit - credit;
    return { periodId: p.id, debit: cents(debit), credit: cents(credit), balance: cents(account.nature === "credit" ? -running : running) };
  });
  return { periods, rows };
}

export interface NodeAccountRow {
  periodId: string;
  accountId: string;
  code: string;
  name: string;
  debit: number;
  credit: number;
}

export interface NodeFigures {
  periods: PeriodRef[];
  /** Debit and credit per account and period, opening and year-close entries left out. */
  accounts: NodeAccountRow[];
  /** Income and expense of the income statement's sections per period (the Resultados of a centro de costo). */
  results: { periodId: string; income: number; expense: number }[];
}

/** The figures of a node of an analytic dimension and of its descendants; null when the node is not visible to the caller. */
export async function nodeFigures(tx: Tx, input: { dimension: Dimension; companyId: string; nodeId: string }): Promise<NodeFigures | null> {
  if (!DIMENSIONS.includes(input.dimension)) throw new Error(`${input.dimension} is not an analytic dimension`);
  const def = DIMENSION_DEFS[input.dimension];
  const view = `accounting.v_${def.table}`;
  const [node] = await tx<{ id: string }[]>`select id from ${tx(view)} where id = ${input.nodeId} and company_id = ${input.companyId}`;
  if (!node) return null;
  const [company] = await tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${input.companyId}`;
  const sections = company ? countryPack(company.country_code).accounting.statementLayouts().incomeStatement.map((s) => s.code) : [];
  const [periods, rows] = await Promise.all([
    listPeriods(tx, input.companyId),
    tx<{ period_id: string; account_id: string | null; code: string | null; name: string | null; section: string | null; debit: string; credit: string }[]>`
      with recursive tree as (select id, parent_id from accounting.master_tree(${input.dimension})),
      below as (
        select id from tree where id = ${input.nodeId}
        union
        select t.id from tree t join below b on t.parent_id = b.id
      )
      select b.period_id, a.id as account_id, a.code, a.name, b.statement_section as section, sum(b.debit) as debit, sum(b.credit) as credit
      from accounting.v_account_balances b left join accounting.v_accounts a on a.id = b.account_id
      where b.company_id = ${input.companyId} and not b.is_opening and not b.is_closing and b.${tx(def.column)} in (select id from below)
      group by b.period_id, a.id, a.code, a.name, b.statement_section
      order by a.code nulls last`,
  ]);
  // An account the caller cannot read: one line per period and section, under the lock, that names none of them.
  const accounts = rows.map((r) => ({
    periodId: r.period_id, accountId: r.account_id ?? "", code: r.account_id === null ? RESTRICTED_CODE : (r.code ?? ""), name: r.account_id === null ? RESTRICTED_NAME : (r.name ?? ""),
    debit: cents(Number(r.debit)), credit: cents(Number(r.credit)),
  }));
  const results = new Map<string, { income: number; expense: number }>();
  for (const r of rows) {
    if (!r.section || !sections.includes(r.section)) continue;
    const current = results.get(r.period_id) ?? { income: 0, expense: 0 };
    if (INCOME_SECTIONS.has(r.section)) current.income += Number(r.credit) - Number(r.debit);
    else current.expense += Number(r.debit) - Number(r.credit);
    results.set(r.period_id, current);
  }
  return { periods, accounts, results: periods.map((p) => ({ periodId: p.id, income: cents(results.get(p.id)?.income ?? 0), expense: cents(results.get(p.id)?.expense ?? 0) })) };
}

// ---- the pages of Períodos (accounting design §8, Task 29) ----------------------------------------------------------------

export interface PeriodSummary extends PeriodRef {
  endsOn: string;
  reopenedFor: string | null;
  reopenedCount: number;
  closedAt: string | null;
  /** Comprobantes posted (reversed ones included) in the period and their totals. */
  entries: number;
  debit: number;
  credit: number;
  /** Comprobantes still in draft or waiting for approval. */
  open: number;
}

export interface YearSummary {
  id: string;
  year: number;
  status: string;
  startsOn: string;
  endsOn: string;
  periods: PeriodSummary[];
}

/** The fiscal years of the company, newest first, each with its twelve periods and what each holds. */
export async function listYears(tx: Tx, companyId: string): Promise<YearSummary[]> {
  const [years, periods] = await Promise.all([
    tx<{ id: string; year: number; status: string; starts_on: string; ends_on: string }[]>`
      select id, year, status, starts_on::text, ends_on::text from accounting.v_fiscal_years where company_id = ${companyId} order by year desc`,
    tx<{ id: string; fiscal_year_id: string; number: number; year: number; starts_on: string; ends_on: string; status: string; reopened_for: string | null; reopened_count: number; closed_at: string | null; entries: number; debit: string; credit: string; open: number }[]>`
      select p.id, p.fiscal_year_id, p.number, y.year, p.starts_on::text, p.ends_on::text, p.status, p.reopened_for::text, p.reopened_count, p.closed_at::text,
             count(e.id) filter (where e.status = 'posted')::int as entries,
             coalesce(sum(e.total_debit) filter (where e.status = 'posted'), 0) as debit,
             coalesce(sum(e.total_credit) filter (where e.status = 'posted'), 0) as credit,
             count(e.id) filter (where e.status in ('draft', 'saved', 'pending', 'rejected', 'approved'))::int as open
      from accounting.v_periods p
      join accounting.v_fiscal_years y on y.id = p.fiscal_year_id
      left join accounting.v_entries e on e.period_id = p.id
      where p.company_id = ${companyId}
      group by p.id, p.fiscal_year_id, p.number, y.year, p.starts_on, p.ends_on, p.status, p.reopened_for, p.reopened_count, p.closed_at
      order by p.starts_on`,
  ]);
  return years.map((y) => ({
    id: y.id,
    year: y.year,
    status: y.status,
    startsOn: y.starts_on,
    endsOn: y.ends_on,
    periods: periods
      .filter((p) => p.fiscal_year_id === y.id)
      .map((p) => ({
        id: p.id, number: p.number, year: p.year, startsOn: p.starts_on, endsOn: p.ends_on, status: p.status, reopenedFor: p.reopened_for, reopenedCount: p.reopened_count,
        closedAt: p.closed_at, entries: p.entries, debit: cents(Number(p.debit)), credit: cents(Number(p.credit)), open: p.open,
      })),
  }));
}

export interface YearPreview {
  year: number;
  status: string;
  /** Periods of the year that are not closed: the year closes only when there are none. */
  openPeriods: number;
  income: number;
  expense: number;
  /** Income minus expense: positive is a profit (utilidad), negative a loss (pérdida). */
  result: number;
  /** Roles the closing entries need and the company has not mapped. */
  missingRoles: string[];
  /** The posted closing comprobantes, for a year that is closed (what Reabrir año will reverse). */
  closingEntries: { id: string; number: string | null; description: string | null; total: number }[];
}

const CLOSING_ROLES = ["income_summary", "current_year_profit", "current_year_loss"] as const;

/** What closing (or reopening) a fiscal year will do, read as the caller; null when the year is not visible. */
export async function yearPreview(tx: Tx, input: { companyId: string; fiscalYearId: string }): Promise<YearPreview | null> {
  const [year] = await tx<{ year: number; status: string }[]>`select year, status from accounting.v_fiscal_years where id = ${input.fiscalYearId} and company_id = ${input.companyId}`;
  if (!year) return null;
  const [company] = await tx<{ country_code: string }[]>`select country_code from kernel.companies where id = ${input.companyId}`;
  const sections = company ? countryPack(company.country_code).accounting.statementLayouts().incomeStatement.map((s) => s.code) : [];
  const [open, rows, mapped, closing] = await Promise.all([
    tx<{ n: number }[]>`select count(*)::int as n from accounting.v_periods where fiscal_year_id = ${input.fiscalYearId} and status <> 'closed'`,
    tx<{ section: string; debit: string; credit: string }[]>`
      select b.statement_section as section, sum(b.debit) as debit, sum(b.credit) as credit
      from accounting.v_account_balances b
      join accounting.v_periods p on p.id = b.period_id
      where b.company_id = ${input.companyId} and p.fiscal_year_id = ${input.fiscalYearId} and not b.is_opening and not b.is_closing and b.statement_section = any(${sections}::text[])
      group by b.statement_section`,
    tx<{ role: string }[]>`select role from accounting.v_account_role_mappings where company_id = ${input.companyId} and dimension is null and role = any(${[...CLOSING_ROLES]}::text[])`,
    tx<{ id: string; number: string | null; description: string | null; total_debit: string }[]>`
      select e.id, e.number, e.description, e.total_debit from accounting.v_entries e join accounting.v_periods p on p.id = e.period_id
      where e.company_id = ${input.companyId} and p.fiscal_year_id = ${input.fiscalYearId} and e.is_closing and e.status = 'posted' and e.reversal_of_id is null and not coalesce((e.extra->>'reversed')::boolean, false)
      order by e.seq`,
  ]);
  let income = 0;
  let expense = 0;
  for (const r of rows) {
    if (INCOME_SECTIONS.has(r.section)) income += Number(r.credit) - Number(r.debit);
    else expense += Number(r.debit) - Number(r.credit);
  }
  const have = new Set(mapped.map((m) => m.role));
  return {
    year: year.year,
    status: year.status,
    openPeriods: open[0]!.n,
    income: cents(income),
    expense: cents(expense),
    result: cents(income - expense),
    missingRoles: CLOSING_ROLES.filter((role) => !have.has(role)),
    closingEntries: closing.map((c) => ({ id: c.id, number: c.number, description: c.description, total: cents(Number(c.total_debit)) })),
  };
}
