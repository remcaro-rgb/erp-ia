import type { SavedGridState } from "@erp/ui";

// Movimientos (accounting design §5.14): where the grid of `accounting.ledger_line` starts. The open period's dates, posted
// lines only, in comprobante order; the columns of the design, with the analytic dimensions that are not on by default
// (settings `use_*`, §4.11) added after the cost center only while the company uses them.

/** The dates of the period the grid opens on. */
export interface MovementsPeriod {
  startsOn: string;
  endsOn: string;
}

/** The optional analytic dimensions the company has switched on. */
export interface MovementsDimensions {
  openAuxiliaries?: boolean;
  items?: boolean;
  businessUnits?: boolean;
}

export function defaultMovementsState(openPeriod: MovementsPeriod | null, uses: MovementsDimensions = {}): SavedGridState {
  const posted = { field: "status", op: "eq", value: "posted" } as const;
  return {
    filters: openPeriod
      ? [{ field: "date", op: "between", value: openPeriod.startsOn, value2: openPeriod.endsOn }, { ...posted, join: "and" }]
      : [posted],
    sort: [
      { field: "date", dir: "asc" },
      { field: "number", dir: "asc" },
      { field: "line_no", dir: "asc" },
    ],
    columns: [
      "date", "number", "journal_code", "account_code", "account_name", "party_name", "cost_center_name",
      ...(uses.openAuxiliaries ? ["open_auxiliary_name"] : []),
      ...(uses.items ? ["item_name"] : []),
      ...(uses.businessUnits ? ["business_unit_name"] : []),
      "description", "debit", "credit", "net", "status",
    ],
  };
}
