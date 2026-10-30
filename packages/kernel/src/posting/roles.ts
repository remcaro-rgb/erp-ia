/** Account roles modules reference in posting templates; the country pack maps each to a chart code (design §5.3). */
export const ACCOUNT_ROLES = [
  "cash", "bank", "receivable", "customer_advances", "revenue", "sales_returns", "sales_discounts", "vat_out", "inc_out", "vat_in",
  "withholding_income_suffered", "withholding_vat_suffered", "withholding_ica_suffered",
  "withholding_income_payable", "withholding_vat_payable", "withholding_ica_payable",
  "inventory", "inventory_adjustment", "cogs", "payable", "supplier_advances", "rounding", "suspense",
  "income_summary", "current_year_profit", "current_year_loss", "retained_earnings", "accumulated_losses", "opening_equity",
] as const;

export type AccountRole = (typeof ACCOUNT_ROLES)[number];
