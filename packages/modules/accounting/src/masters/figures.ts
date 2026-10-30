import { countryPack, type Tx } from "@erp/kernel";
import { DIMENSION_DEFS, DIMENSIONS, type Dimension } from "../dimensions";
import { INCOME_SECTIONS } from "../reports/income-statement";

// The figures the record pages show (accounting design §8, Task 28): the Saldos of a Cuenta per period, and for a node of an
// analytic dimension the Saldos por cuenta and the Resultados per period, descendants included. Like the tree pane they read only the
// published views, so a restricted account the caller may not view is neither a row nor part of a figure (§5.13).

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
      select b.period_id, sum(b.debit) as debit, sum(b.credit) as credit
      from accounting.v_account_balances b join accounting.v_accounts a on a.id = b.account_id
      where b.company_id = ${input.companyId} and a.code like ${`${account.code}%`}
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
    tx<{ period_id: string; account_id: string; code: string; name: string; section: string | null; debit: string; credit: string }[]>`
      with recursive below as (
        select id from ${tx(view)} where id = ${input.nodeId}
        union all
        select t.id from ${tx(view)} t join below b on t.parent_id = b.id
      )
      select b.period_id, a.id as account_id, a.code, a.name, a.statement_section as section, sum(b.debit) as debit, sum(b.credit) as credit
      from accounting.v_account_balances b join accounting.v_accounts a on a.id = b.account_id
      where b.company_id = ${input.companyId} and not b.is_opening and not b.is_closing and b.${tx(def.column)} in (select id from below)
      group by b.period_id, a.id, a.code, a.name, a.statement_section
      order by a.code`,
  ]);
  const accounts = rows.map((r) => ({ periodId: r.period_id, accountId: r.account_id, code: r.code, name: r.name, debit: cents(Number(r.debit)), credit: cents(Number(r.credit)) }));
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
