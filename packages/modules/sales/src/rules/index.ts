import type { DefaultPostingRule } from "@erp/kernel";
import commissionAccrued from "./commission-accrued.json" with { type: "json" };
import commissionReversed from "./commission-reversed.json" with { type: "json" };

// The posting rules the sales module ships (plan 2B.2 Task 30.2, Part G PG §5.4, RG-13; `accounting.posting_rule.sync` installs them for a
// company that has sales on). `commission-accrued`: Dr commission_expense, one line per line of the commission (the base's cost center,
// dimension payee_kind:<employee|agent>) / Cr commissions_payable for the whole commission, the payee as party and the provision's due date
// (so it shows in «Cartera por edades» CxP), same dimension; the commission is in company currency, and so is its entry (no currency path).
// `commission-reversed` reverses the entry of the commission it names (`reverseOf`, found by its source: the commission; Task 30.3 emits it).
// The accounts are the country pack's (rule 5): no account code here. Twins of accounting/src/rules/defaults/, byte for byte
// (rules-equal.test.ts), so a company keeps one copy of each: the sync matches (event, name).
export const SALES_POSTING_RULES: DefaultPostingRule[] = [commissionAccrued, commissionReversed] as DefaultPostingRule[];
