// The small input helpers the record screens' step actions share (sales, stock and invoicing, plan 2B Task 20 fix round 1): the server
// builds each process's input from what the screen sends, and these read it strictly.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A UUID (a record's id, a line's id). */
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** The key the screen made for one click (a retry of the same click runs once): a well-formed UUID, or nothing. */
export const clickKey = (v: unknown): string | undefined => (isUuid(v) ? v : undefined);

/** A text the user typed, trimmed; nothing when it is empty. */
export const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A finite number, or nothing. */
export const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The object without its undefined fields (a process's strict input never sees them). */
export const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
