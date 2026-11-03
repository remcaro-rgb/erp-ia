import type { JSONValue } from "postgres";
import type { ProcessContext } from "../process/context";
import type { ResolvedEntityDef } from "../registry/entities";
import { IDENTIFIER } from "../registry/fields";
import type { RecordStatus } from "./lifecycle";

// Documento snapshots (spec 2026-11-02 §8): the whole document as it stands after a data change or a transition past Borrador,
// written by the lifecycle runner in the process transaction (as the caller: company RLS and the author_is_caller policy of
// kernel.record_snapshots, 0040). Append-only. Maestros get none (they keep the audit log's field diffs).

/** What a snapshot holds: the header row, its lines (`typed.lines`, by line number, else by seq) and the Datos adicionales. */
export interface SnapshotPayload {
  header: Record<string, unknown>;
  lines: Record<string, unknown>[];
  extra: unknown;
  extra_free: unknown;
}

const ident = (entity: ResolvedEntityDef, ...parts: string[]): void => {
  for (const part of parts) if (!IDENTIFIER.test(part)) throw new Error(`entity ${entity.id}: invalid identifier "${part}"`);
};

/** The document `recordId` of `entity` as a snapshot payload, read in the process transaction. */
export async function snapshotPayload(ctx: ProcessContext, entity: ResolvedEntityDef, recordId: string): Promise<SnapshotPayload> {
  ident(entity, entity.schema, entity.table);
  const [row] = await ctx.tx.unsafe<{ header: Record<string, unknown> }[]>(`select to_jsonb(t) as header from ${entity.schema}.${entity.table} t where t.id = $1`, [recordId]);
  if (!row) throw new Error(`snapshot: ${entity.id} ${recordId} not found`);
  const { extra = null, extra_free = null, ...header } = row.header;
  let lines: Record<string, unknown>[] = [];
  if (entity.typed?.lines) {
    const linesEntity = ctx.registry.entity(entity.typed.lines.entity);
    const parent = entity.typed.lines.parentField;
    ident(linesEntity, linesEntity.schema, linesEntity.table, parent);
    // Deterministic order (review of Task 8b): the declared line number first, then the row's gap-free seq (every business table has one,
    // rule 7). Never the uuid alone: lines written in one statement share the millisecond, so their v7 ids sort at random.
    const order = [...(linesEntity.fields.some((f) => f.name === "line_no") ? ["l.line_no"] : []), "l.seq", "l.id"].join(", ");
    const [agg] = await ctx.tx.unsafe<{ lines: Record<string, unknown>[] }[]>(
      `select coalesce(jsonb_agg(to_jsonb(l) order by ${order}), '[]'::jsonb) as lines from ${linesEntity.schema}.${linesEntity.table} l where l.${parent} = $1`,
      [recordId],
    );
    lines = agg!.lines;
  }
  return { header, lines, extra, extra_free };
}

/**
 * Appends a snapshot of documento `recordId` at `status` (the status it has after the step) on the run's causal chain.
 * `reason` is the reason of a No Aprobar or an Anular. Called by the lifecycle runner in the same transaction as the change.
 */
export async function writeSnapshot(ctx: ProcessContext, entity: ResolvedEntityDef, recordId: string, status: RecordStatus, reason?: string | null): Promise<void> {
  if (entity.entityType !== "documento") throw new Error(`entity ${entity.id}: only a documento has snapshots`);
  const payload = await snapshotPayload(ctx, entity, recordId);
  await ctx.tx`
    insert into kernel.record_snapshots (company_id, entity, record_id, status, payload, reason, chain_id)
    values (${ctx.companyId}, ${entity.id}, ${recordId}, ${status}, ${ctx.tx.json(payload as unknown as JSONValue)}, ${reason ?? null}, ${ctx.chainId})`;
}
