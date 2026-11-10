import type { AccountSeed } from "@erp/kernel";
import puc from "../../data/puc.json" with { type: "json" };

// The PUC seed (Decreto 2650 de 1993). Nature, the party and cost-center flags (accounting design §10.3) and the
// statement section are derived from the code, so the JSON stays the plain official list.

const PARTY_GROUPS = ["13", "22", "23", "24", "25", "28"];
// Receivables and payables: the third party must be invoice-ready (rule 10, design §5.17).
const INVOICE_READY_GROUPS = ["1305", "2205"];
const OPENING_RESULT = ["3605", "3705", "3710"];
// Single payables that must name an invoice-ready party although their group does not (rule 10, §22.22): the provision of a commission
// (plan 2B.2 Task 30.2, RG-13; provisional, owner item 159). INVOICE_READY_GROUPS stays as it is: it would flag every 23 and 25 account.
const INVOICE_READY_ACCOUNTS = ["233520", "250505"];

/** Accounts whose balance runs against their class: depreciation and provisions, returns, losses, contra groups. */
const CREDIT_IN_DEBIT_CLASS = ["1199", "1299", "1399", "1499", "1592", "1596", "1597", "1598", "1599", "1698", "1699", "1798", "1899", "1255", "6225", "89"];
const DEBIT_IN_CREDIT_CLASS = ["3610", "361005", "3710", "371005", "4175", "240810", "310510", "310515", "99"];

const startsWith = (code: string, prefixes: string[]) => prefixes.some((p) => code.startsWith(p));

export function natureOf(code: string): "debit" | "credit" {
  const klass = code[0]!;
  const debitClass = ["1", "5", "6", "7", "8"].includes(klass);
  if (debitClass) return startsWith(code, CREDIT_IN_DEBIT_CLASS) ? "credit" : "debit";
  return startsWith(code, DEBIT_IN_CREDIT_CLASS) ? "debit" : "credit";
}

const CURRENT_ASSET = ["11", "12", "13", "14"];
const CURRENT_LIABILITY = ["21", "22", "23", "24", "25", "27", "28"];

/** The statement section of an account (balance sheet or income statement), by group. */
export function sectionOf(code: string): string | undefined {
  const group = code.slice(0, 2);
  if (code.length < 2) return undefined;
  switch (code[0]) {
    case "1": return CURRENT_ASSET.includes(group) ? "assets_current" : "assets_noncurrent";
    case "2": return CURRENT_LIABILITY.includes(group) ? "liabilities_current" : "liabilities_noncurrent";
    case "3": return "equity";
    case "4": return group === "41" ? "revenue" : "other_income";
    case "5": return group === "51" || group === "52" ? "operating_expenses" : group === "53" ? "other_expenses" : group === "54" ? "income_tax" : "result";
    case "6": return "cost_of_sales";
    case "7": return "production_costs";
    default: return undefined;
  }
}

const seed = (code: string, name: string): AccountSeed => ({
  code,
  name,
  nature: natureOf(code),
  requiresParty: startsWith(code, PARTY_GROUPS),
  requiresInvoiceReady: startsWith(code, INVOICE_READY_GROUPS) || INVOICE_READY_ACCOUNTS.includes(code),
  requiresCostCenter: "4567".includes(code[0]!),
  ...(sectionOf(code) ? { statementSection: sectionOf(code)! } : {}),
  isOpeningResult: startsWith(code, OPENING_RESULT),
});

export const chartOfAccounts = (): AccountSeed[] => (puc.accounts as [string, string][]).map(([code, name]) => seed(code, name));

/** Auxiliaries the role mappings need and the PUC does not list (accounting design §5.9). */
export const extraAccounts = (): AccountSeed[] => [
  seed("238095", "Partidas por aclarar"),
  seed("530595", "Ajuste al peso"),
  // The exchange difference of a collection or a revaluation (FX §5, roles fx_gain and fx_loss; provisional, owner item 126 (a)). A receipt's
  // entry has no cost center, so neither account asks for one.
  { ...seed("421020", "Diferencia en cambio"), requiresCostCenter: false },
  { ...seed("530525", "Diferencia en cambio"), requiresCostCenter: false },
  // The expense of a commission by payee kind (plan 2B.2 Task 30.2, RG-13, roles commission_expense; provisional, owner item 159): the seed
  // has 5205 Gastos de personal and 5235 Servicios but none of these subcuentas. Both ask for the cost center of the invoice line.
  seed("520518", "Comisiones"),
  seed("523595", "Otros servicios (comisiones)"),
];
