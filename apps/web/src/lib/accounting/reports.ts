/** The accounting reports in the order of the design (§6), by their short name (`accounting.<name>` is the report id, `/accounting/reports/<name>` its page). */
export const REPORT_ORDER = [
  "trial_balance", "ledger", "balance_sheet", "income_statement", "cost_center_statement", "journal_book", "account_detail",
  "party_detail", "dimension_detail", "aging", "control_reconciliation", "manual_entries_audit", "exogena",
] as const;

/** Reports opened only as the drill-down of another one (the aging's Detalle de cartera, owner 2026-11-11): a page, no card. */
export const DRILL_REPORTS = ["aging_detail"] as const;

export type ReportName = (typeof REPORT_ORDER)[number] | (typeof DRILL_REPORTS)[number];

export const isReportName = (name: string): name is ReportName => (REPORT_ORDER as readonly string[]).includes(name) || (DRILL_REPORTS as readonly string[]).includes(name);
