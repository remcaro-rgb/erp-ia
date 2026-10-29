import type { Tx } from "../db/client";
import { ProcessError } from "../process/errors";
import { requireGridAccess } from "../query/access";
import type { Registry } from "../registry";
import type { ResolvedEntityDef } from "../registry/entities";

// The titles of records named by id (design §19a recent records, §22.14 audit viewer, rule 21 links): each record's display
// field read as the caller through its entity's masked view (rule 14). A record the caller cannot see, or of an entity
// whose grid their roles may not open, gets no title; a display field they see masked or hidden comes back null.

export interface RecordRef {
  entity: ResolvedEntityDef;
  id: string;
}

/** `<entity id>:<record id>` → title (null when the display field is empty or not visible), for the records the caller sees. */
export async function recordTitles(tx: Tx, registry: Registry, refs: readonly RecordRef[]): Promise<Map<string, string | null>> {
  const byEntity = new Map<string, { entity: ResolvedEntityDef; ids: Set<string> }>();
  for (const ref of refs) {
    const group = byEntity.get(ref.entity.id) ?? { entity: ref.entity, ids: new Set<string>() };
    group.ids.add(ref.id);
    byEntity.set(ref.entity.id, group);
  }
  const titles = new Map<string, string | null>();
  for (const { entity, ids } of byEntity.values()) {
    try {
      await requireGridAccess(tx, registry, entity);
    } catch (error) {
      if (error instanceof ProcessError) continue;
      throw error;
    }
    const rows = await tx<{ id: string; title: unknown }[]>`
      select id, ${tx(entity.displayField)} as title from ${tx(`${entity.schema}.v_${entity.table}`)} where id = any (${[...ids]}::uuid[])`;
    for (const row of rows) titles.set(`${entity.id}:${row.id}`, row.title === null || row.title === undefined ? null : String(row.title));
  }
  return titles;
}
