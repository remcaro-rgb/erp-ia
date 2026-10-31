// Where a home card leads (UX-OD-7): a grid screen with the filter that matches the card's number, in the `q` parameter the grids read
// (`gridQueryHref` in @erp/ui, `decodeGridQuery`). Pure: modules build their cards' `href` with it.

export interface KpiFilter {
  field: string;
  op: "eq" | "neq" | "in";
  value: string | boolean | string[];
}

/** `/accounting/entries` + a filter → `/accounting/entries?q=…` (percent-encoded once). */
export function kpiGridHref(path: string, filters: readonly KpiFilter[] = []): string {
  return filters.length === 0 ? path : `${path}?${new URLSearchParams({ q: JSON.stringify({ filters, sort: [] }) })}`;
}
