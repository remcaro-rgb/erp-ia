// The entities that open as a full page at /r/<entity>/<id> (design §5.16) and how to read them. Pure, so
// the page stays thin and the rules are unit-tested.

export interface RecordEntity {
  id: string;
  /** The consult process that returns the record as the caller may see it. */
  consult: string;
  /** Column of the consult row that names the record in the frame's title. */
  titleField: string;
}

const RECORD_ENTITIES: readonly RecordEntity[] = [
  { id: "core.party", consult: "core.party.consult", titleField: "legal_name" },
  { id: "core.product", consult: "core.product.consult", titleField: "description" },
];

/** The entity config, or null for an entity that has no full page (also for inherited object keys). */
export const recordEntity = (id: string): RecordEntity | null => RECORD_ENTITIES.find((e) => e.id === id) ?? null;

const HIDDEN = new Set(["id", "extra", "extra_free"]);

/**
 * The scalar columns of a consult row as name / text pairs: the placeholder of the Datos tab until the real
 * forms of Tasks 12-13. Extra data has its own tab; empty values are left out.
 */
export function datosRows(record: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = [];
  for (const [name, value] of Object.entries(record)) {
    if (HIDDEN.has(name) || value === null || value === undefined) continue;
    if (value instanceof Date) rows.push([name, value.toISOString()]);
    else if (Array.isArray(value)) rows.push([name, value.join(", ")]);
    else if (typeof value === "object") continue;
    else rows.push([name, String(value)]);
  }
  return rows;
}
