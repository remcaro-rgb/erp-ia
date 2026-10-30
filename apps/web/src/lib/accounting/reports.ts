/** The accounting reports in the order of the design (§6), by their short name (`accounting.<name>` is the report id, `/accounting/reports/<name>` its page). */
export const REPORT_ORDER = [
  "trial_balance", "ledger", "balance_sheet", "income_statement", "cost_center_statement", "journal_book", "account_detail",
  "party_detail", "dimension_detail", "aging", "control_reconciliation", "manual_entries_audit", "exogena",
] as const;

export type ReportName = (typeof REPORT_ORDER)[number];

export const isReportName = (name: string): name is ReportName => (REPORT_ORDER as readonly string[]).includes(name);
