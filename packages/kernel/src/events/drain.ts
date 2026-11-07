import type { Sql } from "postgres";
import { start } from "workflow/api";
import { registry } from "../registry";
import { consumers } from "./consumers";
import { dispatchOutboxRow } from "./dispatch.workflow";

/** A claim older than this is void: its workflow run is presumed lost and the row is claimed again. */
const CLAIM_WINDOW = "10 minutes";

/**
 * Claims up to `limit` undispatched outbox rows, oldest first, and starts one `dispatchOutboxRow`
 * workflow run per row. Returns how many it started. Plain Node: called by the route handler /
 * scheduler tick and by the Postgres World worker.
 *
 * The claim (`claimed_at = now()`) is committed before any workflow starts, so row locks are never
 * held across Workflow world I/O, and a row with a live claim (in flight or retrying) is not claimed
 * by an overlapping or repeated drain. A row parked with `last_error = 'module_disabled'` is skipped
 * until none of the consumer modules of its event is disabled for its company any more (design §5.12:
 * paused, queued, not dropped). Throws `outbox: no modules loaded` when the process has registered no
 * module: draining then would hand events to a worker that cannot run their consumers. `companyIds` limits the claim
 * to those companies' rows.
 */
export interface DrainOptions {
  /** Only rows of these companies (a test suite that owns its rows); every company when absent. */
  companyIds?: readonly string[];
}

export async function drainOutbox(sql: Sql, limit = 100, options: DrainOptions = {}): Promise<number> {
  if (registry.modules().length === 0) throw new Error("outbox: no modules loaded");

  // Dead letters of a module the company may use now (bought by any path, or the dispatcher raced the purchase) go back first.
  await sql`select kernel.parked_events_sweep(${options.companyIds ? [...options.companyIds] : null}::uuid[])`;

  const ids = await sql.begin(async (tx) => {
    const gates = tx.json(consumers.pairs());
    const companies = options.companyIds ? [...options.companyIds] : null;
    const rows = await tx<{ id: string }[]>`
      select o.id from kernel.outbox o
      where o.dispatched_at is null
        and (${companies}::uuid[] is null or o.company_id = any(${companies}::uuid[]))
        and (o.claimed_at is null or o.claimed_at < now() - ${CLAIM_WINDOW}::interval)
        and (
          o.last_error is distinct from 'module_disabled'
          or not exists (
            select 1
            from jsonb_to_recordset(${gates}::jsonb) as c(event text, module_id text)
            join kernel.company_modules cm on cm.module_id = c.module_id and cm.company_id = o.company_id
            where (c.event = o.event or c.event = '*') and not cm.enabled
          )
        )
      order by o.created_at
      limit ${limit}
      for update of o skip locked`;
    const claimed = rows.map((row) => row.id);
    await tx`update kernel.outbox set claimed_at = now() where id = any(${claimed}::uuid[])`;
    return claimed;
  });

  for (const [index, id] of ids.entries()) {
    try {
      await start(dispatchOutboxRow, [id]);
    } catch (error) {
      // The rows whose run never started must not wait out the claim window.
      await sql`update kernel.outbox set claimed_at = null where id = any(${ids.slice(index)}::uuid[])`;
      throw error;
    }
  }
  return ids.length;
}
