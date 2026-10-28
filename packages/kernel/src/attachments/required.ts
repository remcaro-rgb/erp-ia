import type { Sql } from "postgres";
import { withClaims, type JwtClaims } from "../db/client";

/** The file kinds a required definition accepts. */
export type RequiredKind = "pdf" | "image" | "any";

/** What the required-file conditions (`co`, `co-juridica`, `proveedor`, `cliente`) read from the owning record. */
export interface RecordFacts {
  id: string;
  companyId: string;
  /** ISO country of the record (`CO`); entities without a country omit it. */
  countryCode?: string | null;
  /** `1` juridical, `2` natural. */
  personType?: string | null;
  /** Party kinds (`customer`, `supplier`, `employee`). */
  kind?: readonly string[] | null;
}

/**
 * Tags of the required files the record still lacks (design §5.13, §5.17), sorted by tag: the
 * required definitions that apply to the record and have no live file of a fitting type. It calls
 * `kernel.missing_attachments`, the function the `invoice_ready` triggers use, so the answer here
 * and the stored flag cannot disagree. Accepts the pool or a transaction.
 */
export async function missingAttachments(db: Sql, entity: string, record: RecordFacts): Promise<string[]> {
  const kind = record.kind ? [...record.kind] : null;
  const [row] = await db<{ missing: string[] }[]>`
    select kernel.missing_attachments(
      ${record.companyId}::uuid, ${entity}, ${record.id}::uuid,
      ${record.countryCode ?? null}, ${record.personType ?? null}, ${kind}::text[]
    ) as missing`;
  return row!.missing;
}

/** The facts a condition reads; `undefined` means the caller cannot see the fact, `null` that the record has none. */
export type ConditionFacts = Pick<RecordFacts, "countryCode" | "personType" | "kind">;

/**
 * Whether a required-file definition applies to a record: the TypeScript twin of the `case` in
 * `kernel.missing_attachments` (migration 0007), so the checklist the record page shows and the stored
 * `invoice_ready` flag agree. A condition it does not know applies, and so does one whose fact the caller cannot see
 * (`undefined`: hidden by a field permission): a requirement is never silently waived.
 */
export function requirementApplies(condition: string | null, facts: ConditionFacts): boolean {
  switch (condition) {
    case null:
      return true;
    case "co":
      return facts.countryCode === undefined || facts.countryCode === "CO";
    case "co-juridica":
      return (facts.countryCode === undefined || facts.countryCode === "CO") && (facts.personType === undefined || facts.personType === "1");
    case "proveedor":
      return facts.kind === undefined || (facts.kind ?? []).includes("supplier");
    case "cliente":
      return facts.kind === undefined || (facts.kind ?? []).includes("customer");
    default:
      return true;
  }
}

/** A required file as the record page's checklist shows it. */
export interface RequiredTag {
  tag: string;
  kind: RequiredKind;
  /** `false`: the file is welcome but its absence does not block the record. */
  required: boolean;
  description?: string;
}

/**
 * The required-file definitions of the caller's company for `entity` that apply to a record with these facts, by
 * tag, read through `kernel.v_required_attachments` as the caller (company RLS).
 */
export async function requiredTagsFor(db: Sql, claims: JwtClaims, entity: string, facts: ConditionFacts): Promise<RequiredTag[]> {
  const rows = await withClaims(
    db,
    claims,
    (tx) => tx<{ tag: string; kind: RequiredKind; required: boolean; condition: string | null; description: string | null }[]>`
      select tag, kind, required, condition, description from kernel.v_required_attachments where entity = ${entity}`,
  );
  return rows
    .filter((row) => requirementApplies(row.condition, facts))
    .map((row): RequiredTag => ({ tag: row.tag, kind: row.kind, required: row.required, ...(row.description ? { description: row.description } : {}) }))
    .sort((a, b) => a.tag.localeCompare(b.tag, "es"));
}
