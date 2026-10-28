import { z } from "zod";
import { requireGridAccess } from "../query/access";
import { defineProcess } from "../process/define";
import { ProcessError } from "../process/errors";
import { HOME_FEATURE } from "./kpis";

// The "recent records" widget (design §19a): the last records the caller created or changed, from the audit log as the
// caller sees it (`kernel.v_audit_log`: their own entries), titled through each entity's masked read view (rule 14). A record
// the caller can no longer see, or of an entity their roles may not consult, is left out.

const DEFAULT_LIMIT = 10;
/** Audit entries read per wanted record: some records turn out hidden and drop out. */
const CANDIDATES_PER_RECORD = 4;
const MAX_CANDIDATES = 80;

const record = z.object({
  entity: z.string(),
  /** i18n key of the entity's name. */
  entityLabel: z.string(),
  id: z.uuid(),
  title: z.string().nullable(),
  action: z.enum(["insert", "update"]),
  at: z.string(),
});

export const homeRecent = defineProcess({
  id: "kernel.home.recent",
  module: "kernel",
  kind: "consult",
  feature: HOME_FEATURE,
  description: "Consulta los últimos registros que el usuario creó o modificó, con su nombre y cuándo",
  input: z.object({ limit: z.number().int().min(1).max(20).default(DEFAULT_LIMIT) }),
  output: z.object({ records: z.array(record) }),
  handler: async (ctx, { limit }) => {
    // Row changes inside a process are logged as <schema>.<table>; the registered entity of that table is what is shown.
    const byTable = new Map(ctx.registry.entities().map((e) => [`${e.schema}.${e.table}`, e]));
    if (byTable.size === 0) return { records: [] };

    const candidates = await ctx.tx<{ entity: string; row_id: string; action: "insert" | "update"; occurred_at: Date }[]>`
      select entity, row_id, action, occurred_at from (
        select distinct on (entity, row_id) entity, row_id, action, occurred_at
        from kernel.v_audit_log
        where company_id = ${ctx.companyId}
          and action in ('insert', 'update')
          and process_id is not null
          and row_id is not null
          and entity = any (${[...byTable.keys()]}::text[])
        order by entity, row_id, occurred_at desc
      ) latest
      order by occurred_at desc, row_id
      limit ${Math.min(limit * CANDIDATES_PER_RECORD, MAX_CANDIDATES)}`;

    // The entities of these records the caller may open, and the titles of the records they still see.
    const idsByEntity = new Map<string, string[]>();
    for (const c of candidates) idsByEntity.set(c.entity, [...(idsByEntity.get(c.entity) ?? []), c.row_id]);
    const titles = new Map<string, string | null>();
    for (const [table, ids] of idsByEntity) {
      const entity = byTable.get(table)!;
      try {
        await requireGridAccess(ctx.tx, ctx.registry, entity);
      } catch (error) {
        if (error instanceof ProcessError) continue;
        throw error;
      }
      const rows = await ctx.tx<{ id: string; title: unknown }[]>`
        select id, ${ctx.tx(entity.displayField)} as title from ${ctx.tx(`${entity.schema}.v_${entity.table}`)} where id = any (${ids}::uuid[])`;
      for (const row of rows) titles.set(`${table}:${row.id}`, row.title === null || row.title === undefined ? null : String(row.title));
    }

    const records = candidates.flatMap((c) => {
      const key = `${c.entity}:${c.row_id}`;
      if (!titles.has(key)) return [];
      const entity = byTable.get(c.entity)!;
      return [{ entity: entity.id, entityLabel: entity.label, id: c.row_id, title: titles.get(key)!, action: c.action, at: c.occurred_at.toISOString() }];
    });
    return { records: records.slice(0, limit) };
  },
});
