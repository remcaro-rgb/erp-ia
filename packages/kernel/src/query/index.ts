// The grid query layer (design §9). This entry point is dependency-free (zod only) so the browser can share the
// grid state and the operators by type (`@erp/kernel/query`); running a query needs the database: `runGridQuery`
// from the package root.
export { buildQuery } from "./build-query";
export type { BuildQueryOptions, BuiltQuery } from "./build-query";
export { QueryError } from "./errors";
export { labelText, refLabelKey } from "./ref-label";
export type { QueryErrorCode } from "./errors";
export {
  AGGREGATE_FNS,
  CODE_SET_OPS,
  customFilterKind,
  EXTRA_KEY,
  EXTRA_PREFIX,
  FILTER_OPS,
  filterKind,
  GridFilter,
  GridSort,
  GridState,
  NO_VALUE_OPS,
  OPERATORS,
  operatorsFor,
  orGroups,
} from "./grid-state";
export type { AggregateFn, FilterKind, FilterOp, GridStateInput } from "./grid-state";
