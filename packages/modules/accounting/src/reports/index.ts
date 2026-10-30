import type { ProcessDef, ReportDef } from "@erp/kernel";
import { balanceSheetConsult, balanceSheetReport } from "./balance-sheet";
import { costCenterStatementConsult, costCenterStatementReport } from "./cost-center-statement";
import { incomeStatementConsult, incomeStatementReport } from "./income-statement";
import { ledgerConsult, ledgerReport, trialBalanceConsult, trialBalanceReport } from "./trial-balance";

/** The consult process behind each report (Tasks 22–24 append theirs). */
export const REPORT_PROCESSES: ProcessDef[] = [trialBalanceConsult, ledgerConsult, balanceSheetConsult, incomeStatementConsult, costCenterStatementConsult];

/** The report definitions of the module manifest. */
export const ACCOUNTING_REPORTS: ReportDef[] = [trialBalanceReport, ledgerReport, balanceSheetReport, incomeStatementReport, costCenterStatementReport];
