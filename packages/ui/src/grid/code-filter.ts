import type { FilterOp, GridColumn, GridStateInput } from "./types";

// Rule 20: a column is filtered by what the user sees. A coded column (a DANE municipality, a document type, a tax
// scheme…) stores the code and shows its label from the pack's table, so a text rule the user typed ("contiene
// Medell") is turned here, before the request leaves the browser, into a set of the codes whose label (or code)
// matches: the server stays generic (`in` / `nin` over text, `@erp/kernel/query`). Saved views keep the text as
// typed, so their chips read as the user wrote them.

type Filter = NonNullable<GridStateInput["filters"]>[number];

/** The positive rule each text rule tests a label with; `ncontains` / `neq` keep the codes it does not match. */
const POSITIVE: Partial<Record<FilterOp, FilterOp>> = { contains: "contains", starts: "starts", ends: "ends", eq: "eq", ncontains: "contains", neq: "eq" };

/** Without accents, case or surrounding spaces: "Medellín" and "MEDELLIN" read the same. */
export const foldText = (text: string): string => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

function matches(op: FilterOp, text: string, needle: string): boolean {
  const folded = foldText(text);
  if (op === "contains") return folded.includes(needle);
  if (op === "starts") return folded.startsWith(needle);
  if (op === "ends") return folded.endsWith(needle);
  return folded === needle;
}

/** The filter as the server receives it: a text rule on a coded column becomes `in` / `nin` over its codes; any other filter is returned as it is. */
export function codeFilter(column: GridColumn | undefined, filter: Filter): Filter {
  const positive = POSITIVE[filter.op];
  if (!column?.options?.length || column.kind !== "text" || !positive) return filter;
  if (typeof filter.value !== "string" && typeof filter.value !== "number") return filter;
  const needle = foldText(String(filter.value));
  if (needle === "") return filter;
  const codes = column.options.filter((o) => matches(positive, o.label, needle) || matches(positive, o.value, needle)).map((o) => o.value);
  const sent: Filter = { ...filter, op: positive === filter.op ? "in" : "nin", value: codes };
  delete sent.value2;
  return sent;
}

/** Every filter of a request through `codeFilter`, with its column. */
export function serverFilters(columns: readonly GridColumn[], filters: readonly Filter[]): Filter[] {
  const byField = new Map(columns.map((c) => [c.field, c]));
  return filters.map((f) => codeFilter(byField.get(f.field), f));
}
