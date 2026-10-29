// Column lists shared by the audit detail (audit/detail.ts) and cloning (records/clone.ts), so what the audit never
// shows and what a clone never copies stay one decision. Migration 0025's `kernel.audit_row_change()` drops the same
// SECRET_COLUMNS from what it records (SQL cannot import this list: keep them in step).

/** Columns every table carries that say nothing about the record's data: the server sets them. */
export const TECHNICAL_COLUMNS: ReadonlySet<string> = new Set(["id", "company_id", "created_at", "updated_at", "created_by", "updated_by"]);

/** Never shown by the audit and never copied by a clone, whatever an entity declares. */
export const SECRET_COLUMNS: ReadonlySet<string> = new Set(["token", "secret", "password"]);
