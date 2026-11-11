import type { ProcessContext } from "@erp/kernel";
import { RESTRICTED_CODE, RESTRICTED_NAME } from "./common";

// The subledger tie-out of accounting design §5.12.3, §5.12.4 and §4.14: receivable and payable by party against the open items,
// inventory against the stock value, the suspense account at zero, and the rounding account within tolerance. Shared by
// `period.close` (the checks) and `accounting.report.control_reconciliation` (Task 24). Account groups come from the company's role
// mappings (the first two digits of the accounts mapped to the receivable / payable roles), so no chart code is written here; only
// accounts the caller may view (§5.13) enter the figures, on both sides, so the comparison stays coherent for a restricted reader.
// The record rules never change a figure or a check (D11, Task 9 review I1): the amounts come from the security-definer aggregates of
// 0046, and a party or an account a rule hides from the caller is a `restricted` line with no id or code, still compared and counted.

export interface PartyDifference {
  /** Empty, with the lock as the code, when the caller may not read the account or the party (`restricted`). */
  accountId: string;
  accountCode: string;
  partyId: string;
  restricted?: boolean;
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
  rounding: { mapped: boolean; net: number; lines: number; oversized: { entryId: string; lineNo: number; amount: number }[]; oversizedHidden: number };
}

const num = (value: unknown) => Number(value ?? 0);

/** The ledger-versus-subledger and balance controls as of `asOf` (YYYY-MM-DD); `from` is the first day of the rounding period. */
export async function controlReconciliation(ctx: ProcessContext, asOf: string, from: string, tolerance: number): Promise<ControlReconciliation> {
  const side = async (): Promise<{ receivable: SideControl; payable: SideControl }> => {
    const rows = await ctx.tx<{ is_receivable: boolean; account_id: string | null; code: string | null; party_id: string | null; restricted: boolean; balance: string; open: string }[]>`
      select is_receivable, account_id, code, party_id, restricted, balance, open from accounting.control_party_balances(${asOf}::date)`;
    const toDifference = (r: (typeof rows)[number]): PartyDifference => ({
      accountId: r.account_id ?? "", accountCode: r.code ?? RESTRICTED_CODE, partyId: r.party_id ?? "", ledger: num(r.balance), open: num(r.open),
      ...(r.restricted ? { restricted: true } : {}),
    });
    const build = (receivable: boolean): SideControl => {
      const own = rows.filter((r) => r.is_receivable === receivable);
      return {
        parties: own.map(toDifference),
        ledger: own.reduce((sum, r) => sum + num(r.balance), 0),
        open: own.reduce((sum, r) => sum + num(r.open), 0),
        differences: own.filter((r) => Math.abs(num(r.balance) - num(r.open)) > tolerance).map(toDifference),
      };
    };
    return { receivable: build(true), payable: build(false) };
  };

  const inventory = async (): Promise<InventoryControl> => {
    const [view] = await ctx.tx<{ present: boolean }[]>`select to_regclass('inventory.v_stock_value') is not null as present`;
    if (!view!.present) return { available: false, ledger: 0, stock: 0, difference: 0 };
    const [ledger] = await ctx.tx<{ balance: string }[]>`select accounting.control_role_group_balance(${asOf}::date, 'inventory') as balance`;
    const [stock] = await ctx.tx.unsafe<{ value: string }[]>("select coalesce(sum(value), 0) as value from inventory.v_stock_value where company_id = $1", [ctx.companyId]);
    const l = num(ledger!.balance);
    const s = num(stock!.value);
    return { available: true, ledger: l, stock: s, difference: l - s };
  };

  // Whether the role is mapped: the mapping rows carry no account data, so the caller's rules never change the answer.
  const mapped = async (role: string) =>
    (await ctx.tx`select 1 from accounting.account_role_mappings where company_id = ${ctx.companyId} and role = ${role} and dimension is null`).length > 0;

  const suspense: ControlReconciliation["suspense"] = { mapped: await mapped("suspense"), balance: 0, accounts: [] };
  if (suspense.mapped) {
    const rows = await ctx.tx<{ account_id: string | null; code: string | null; name: string | null; balance: string }[]>`
      select account_id, code, name, balance from accounting.control_role_account_balances(${asOf}::date, 'suspense')`;
    suspense.accounts = rows.map((r) => ({ accountId: r.account_id ?? "", code: r.code ?? RESTRICTED_CODE, name: r.name ?? RESTRICTED_NAME, balance: num(r.balance) }));
    suspense.balance = suspense.accounts.reduce((sum, r) => sum + r.balance, 0);
  }

  const rounding: ControlReconciliation["rounding"] = { mapped: await mapped("rounding"), net: 0, lines: 0, oversized: [], oversizedHidden: 0 };
  if (rounding.mapped) {
    const [sum] = await ctx.tx<{ lines: number; net: string; hidden_oversized: number }[]>`
      select lines, net, hidden_oversized from accounting.control_role_lines(${from}::date, ${asOf}::date, 'rounding', ${tolerance})`;
    rounding.lines = sum!.lines;
    rounding.net = num(sum!.net);
    rounding.oversizedHidden = sum!.hidden_oversized;
    // The oversized lines the caller may read, by comprobante and line (the RLS tables drop the hidden ones, which are only counted).
    const rows = await ctx.tx<{ entry_id: string; line_no: number; debit: string; credit: string }[]>`
      select l.entry_id, l.line_no, l.debit, l.credit
      from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
      join accounting.account_role_mappings m on m.account_id = l.account_id and m.company_id = l.company_id and m.role = 'rounding' and m.dimension is null
      where l.company_id = ${ctx.companyId} and e.status = 'posted'
        and e.date between ${from}::date and ${asOf}::date and accounting.can_view_account(l.account_id)`;
    rounding.oversized = rows
      .map((r) => ({ entryId: r.entry_id, lineNo: r.line_no, amount: Math.max(num(r.debit), num(r.credit)) }))
      .filter((r) => r.amount > tolerance);
  }

  return { asOf, tolerance, ...(await side()), inventory: await inventory(), suspense, rounding };
}
