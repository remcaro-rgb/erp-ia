import type { Sql } from "postgres";

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
