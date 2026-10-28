/**
 * Why a grid state was refused. `field_hidden` (the field is hidden or masked for the caller: rule 14, a
 * masked field never filters or sorts) is a denial (HTTP 403); the others are a malformed request (400).
 */
export type QueryErrorCode = "unknown_field" | "field_hidden" | "field_not_filterable" | "field_not_sortable" | "bad_operator" | "bad_value";

export class QueryError extends Error {
  readonly code: QueryErrorCode;
  /** The field the refusal is about. */
  readonly field: string;

  constructor(code: QueryErrorCode, field: string, message?: string) {
    super(`${code}: ${message ?? field}`);
    this.name = "QueryError";
    this.code = code;
    this.field = field;
  }
}
