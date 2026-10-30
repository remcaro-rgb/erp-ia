import type { ProcessContext } from "@erp/kernel";

// The subledger tie-out of accounting design §5.12.3, §5.12.4 and §4.14: receivable and payable by party against the open items,
// inventory against the stock value, the suspense account at zero, and the rounding account within tolerance. Shared by
// `period.close` (the checks) and `accounting.report.control_reconciliation` (Task 24). Account groups come from the company's role
// mappings (the first two digits of the accounts mapped to the receivable / payable roles), so no chart code is written here; only
// accounts the caller may view enter the figures, on both sides, so the comparison stays coherent for a restricted reader.

export interface PartyDifference {
  accountId: string;
  accountCode: string;
  partyId: string;
  ledger: number;
  open: number;
}

export interface SideControl {
  ledger: number;
  open: number;
  /** Every party (per account) with a ledger balance or open items. */
  parties: PartyDifference[];
  /** Those whose ledger balance and open items differ by more than the tolerance. */
  differences: PartyDifference[];
}

export interface InventoryControl {
  /** False when no inventory module is installed: nothing to tie. */
  available: boolean;
  ledger: number;
  stock: number;
  difference: number;
}

export interface AccountBalanceLine {
  accountId: string;
  code: string;
  name: string;
  balance: number;
}

export interface ControlReconciliation {
  asOf: string;
  tolerance: number;
  receivable: SideControl;
  payable: SideControl;
  inventory: InventoryControl;
  /** The suspense account and its descendants: the net balance and the accounts that hold it. */
  suspense: { mapped: boolean; balance: number; accounts: AccountBalanceLine[] };
  /** Lines posted to the rounding account in the period whose amount exceeds the tolerance (a person posted them by hand). */
  rounding: { mapped: boolean; net: number; lines: number; oversized: { entryId: string; lineNo: number; amount: number }[] };
}

const num = (value: unknown) => Number(value ?? 0);

/** The ledger-versus-subledger and balance controls as of `asOf` (YYYY-MM-DD); `from` is the first day of the rounding period. */
export async function controlReconciliation(ctx: ProcessContext, asOf: string, from: string, tolerance: number): Promise<ControlReconciliation> {
  const side = async (): Promise<{ receivable: SideControl; payable: SideControl }> => {
    const rows = await ctx.tx<{ is_receivable: boolean; account_id: string; code: string; party_id: string; balance: string; open: string }[]>`
      with groups as (
        select distinct left(a.code, 2) as grp, (m.role = 'receivable' or m.role like '%\_receivable') as is_receivable
        from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
        where m.company_id = ${ctx.companyId}
          and (m.role = 'receivable' or m.role like '%\_receivable' or m.role = 'payable' or m.role like '%\_payable')
      ),
      ledger as (
        select l.account_id, a.code, l.party_id, g.is_receivable,
               sum(case when g.is_receivable then l.debit - l.credit else l.credit - l.debit end) as balance
        from accounting.entry_lines l
        join accounting.entries e on e.id = l.entry_id
        join accounting.accounts a on a.id = l.account_id
        join groups g on g.grp = left(a.code, 2)
        where l.company_id = ${ctx.companyId} and a.requires_party and l.party_id is not null
          and e.status in ('posted', 'reversed') and e.date <= ${asOf}::date and accounting.can_view_account(l.account_id)
        group by l.account_id, a.code, l.party_id, g.is_receivable
      ),
      opened as (
        select o.account_id, o.party_id, sum(o.open) as open from accounting.open_items(${ctx.companyId}, ${asOf}::date) o group by o.account_id, o.party_id
      )
      select l.is_receivable, l.account_id, l.code, l.party_id, l.balance, coalesce(o.open, 0) as open
      from ledger l left join opened o on o.account_id = l.account_id and o.party_id = l.party_id
      order by l.code, l.party_id`;
    const build = (receivable: boolean): SideControl => {
      const own = rows.filter((r) => r.is_receivable === receivable);
      const all = own.map((r) => ({ accountId: r.account_id, accountCode: r.code, partyId: r.party_id, ledger: num(r.balance), open: num(r.open) }));
      return {
        parties: all,
        ledger: own.reduce((sum, r) => sum + num(r.balance), 0),
        open: own.reduce((sum, r) => sum + num(r.open), 0),
        differences: own
          .filter((r) => Math.abs(num(r.balance) - num(r.open)) > tolerance)
          .map((r) => ({ accountId: r.account_id, accountCode: r.code, partyId: r.party_id, ledger: num(r.balance), open: num(r.open) })),
      };
    };
    return { receivable: build(true), payable: build(false) };
  };

  const inventory = async (): Promise<InventoryControl> => {
    const [view] = await ctx.tx<{ present: boolean }[]>`select to_regclass('inventory.v_stock_value') is not null as present`;
    if (!view!.present) return { available: false, ledger: 0, stock: 0, difference: 0 };
    const [ledger] = await ctx.tx<{ balance: string }[]>`
      select coalesce(sum(l.debit - l.credit), 0) as balance
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date <= ${asOf}::date and accounting.can_view_account(l.account_id)
        and left(a.code, 2) in (select left(a2.code, 2) from accounting.account_role_mappings m join accounting.accounts a2 on a2.id = m.account_id
                                where m.company_id = ${ctx.companyId} and m.role = 'inventory')`;
    const [stock] = await ctx.tx.unsafe<{ value: string }[]>("select coalesce(sum(value), 0) as value from inventory.v_stock_value where company_id = $1", [ctx.companyId]);
    const l = num(ledger!.balance);
    const s = num(stock!.value);
    return { available: true, ledger: l, stock: s, difference: l - s };
  };

  const roleAccount = async (role: string) => {
    const [row] = await ctx.tx<{ account_id: string; code: string }[]>`
      select m.account_id, a.code from accounting.account_role_mappings m join accounting.accounts a on a.id = m.account_id
      where m.company_id = ${ctx.companyId} and m.role = ${role} and m.dimension is null`;
    return row;
  };

  const suspenseAccount = await roleAccount("suspense");
  const suspense: ControlReconciliation["suspense"] = { mapped: !!suspenseAccount, balance: 0, accounts: [] };
  if (suspenseAccount) {
    const rows = await ctx.tx<{ account_id: string; code: string; name: string; balance: string }[]>`
      select a.id as account_id, a.code, a.name, sum(l.debit - l.credit) as balance
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
      where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date <= ${asOf}::date
        and a.code like ${`${suspenseAccount.code}%`} and accounting.can_view_account(l.account_id)
      group by a.id, a.code, a.name having sum(l.debit - l.credit) <> 0 order by a.code`;
    suspense.accounts = rows.map((r) => ({ accountId: r.account_id, code: r.code, name: r.name, balance: num(r.balance) }));
    suspense.balance = suspense.accounts.reduce((sum, r) => sum + r.balance, 0);
  }

  const roundingAccount = await roleAccount("rounding");
  const rounding: ControlReconciliation["rounding"] = { mapped: !!roundingAccount, net: 0, lines: 0, oversized: [] };
  if (roundingAccount) {
    const rows = await ctx.tx<{ entry_id: string; line_no: number; debit: string; credit: string }[]>`
      select l.entry_id, l.line_no, l.debit, l.credit
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      where l.company_id = ${ctx.companyId} and l.account_id = ${roundingAccount.account_id} and e.status in ('posted', 'reversed')
        and e.date between ${from}::date and ${asOf}::date and accounting.can_view_account(l.account_id)`;
    rounding.lines = rows.length;
    rounding.net = rows.reduce((sum, r) => sum + num(r.debit) - num(r.credit), 0);
    rounding.oversized = rows
      .map((r) => ({ entryId: r.entry_id, lineNo: r.line_no, amount: Math.max(num(r.debit), num(r.credit)) }))
      .filter((r) => r.amount > tolerance);
  }

  return { asOf, tolerance, ...(await side()), inventory: await inventory(), suspense, rounding };
}
