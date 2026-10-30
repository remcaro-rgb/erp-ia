import type { ProcessDef, ReportDef } from "@erp/kernel";
import { accountDetailConsult, accountDetailReport } from "./account-detail";
import { agingConsult, agingReport } from "./aging";
import { controlReconciliationConsult, controlReconciliationReport } from "./control-reconciliation-report";
import { exogenaConsult, exogenaReport } from "./exogena";
import { manualEntriesAuditConsult, manualEntriesAuditReport } from "./manual-entries-audit";
import { balanceSheetConsult, balanceSheetReport } from "./balance-sheet";
import { costCenterStatementConsult, costCenterStatementReport } from "./cost-center-statement";
import { dimensionDetailConsult, dimensionDetailReport } from "./dimension-detail";
import { incomeStatementConsult, incomeStatementReport } from "./income-statement";
import { journalBookConsult, journalBookReport } from "./journal-book";
import { partyDetailConsult, partyDetailReport } from "./party-detail";
import { ledgerConsult, ledgerReport, trialBalanceConsult, trialBalanceReport } from "./trial-balance";

/** The consult process behind each report (Tasks 22–24 append theirs). */
export const REPORT_PROCESSES: ProcessDef[] = [trialBalanceConsult, ledgerConsult, balanceSheetConsult, incomeStatementConsult, costCenterStatementConsult,
  journalBookConsult, accountDetailConsult, partyDetailConsult, dimensionDetailConsult,
  controlReconciliationConsult, manualEntriesAuditConsult, agingConsult, exogenaConsult,
];

/** The report definitions of the module manifest. */
export const ACCOUNTING_REPORTS: ReportDef[] = [trialBalanceReport, ledgerReport, balanceSheetReport, incomeStatementReport, costCenterStatementReport,
  journalBookReport, accountDetailReport, partyDetailReport, dimensionDetailReport,
  controlReconciliationReport, manualEntriesAuditReport, agingReport, exogenaReport,
];
