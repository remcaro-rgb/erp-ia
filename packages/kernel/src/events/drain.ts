import type { Sql } from "postgres";
import { start } from "workflow/api";
import { consumers } from "./consumers";
import { dispatchOutboxRow } from "./dispatch.workflow";

/**
 * Claims up to `limit` undispatched outbox rows (`for update skip locked`, oldest first) and starts
 * one `dispatchOutboxRow` workflow run per row. Returns how many it started. Plain Node: called by
 * the route handler / scheduler tick and by the Postgres World worker.
 *
 * A row parked with `last_error = 'module_disabled'` is skipped until no consumer module of its
 * event is disabled for its company any more (design §5.12: paused, queued, not dropped).
 */
export async function drainOutbox(sql: Sql, limit = 100): Promise<number> {
  return sql.begin(async (tx) => {
    const gates = tx.json(consumers.pairs());
    const rows = await tx<{ id: string }[]>`
      select o.id from kernel.outbox o
      where o.dispatched_at is null
        and (
          o.last_error is distinct from 'module_disabled'
          or not exists (
            select 1
            from jsonb_to_recordset(${gates}::jsonb) as c(event text, module_id text)
            join kernel.company_modules cm on cm.module_id = c.module_id and cm.company_id = o.company_id
            where c.event = o.event and not cm.enabled
          )
        )
      order by o.created_at
      limit ${limit}
      for update of o skip locked`;
    for (const row of rows) await start(dispatchOutboxRow, [row.id]);
    return rows.length;
  });
}
