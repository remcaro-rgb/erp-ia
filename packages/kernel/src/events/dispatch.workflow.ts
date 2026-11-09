import { FatalError, RetryableError, getStepMetadata } from "workflow";
import type { JSONValue, Sql } from "postgres";
import { getServiceDb } from "../db/service";
import { moduleGate } from "../entitlements/resolver";
import { ProcessError, type ProcessErrorCode } from "../process/errors";
import { registry } from "../registry";
import { buildConsumerContext, consumers } from "./consumers";

interface OutboxRow {
  id: string;
  createdAt: Date;
  companyId: string;
  event: string;
  payload: unknown;
  chainId: string;
}

type ConsumerResult = "done" | "module_disabled" | "not_purchased";

/** Refusals that repeating the run cannot fix: they dead-letter at once instead of burning retries. */
const DETERMINISTIC: ReadonlySet<ProcessErrorCode> = new Set(["invalid_input", "forbidden", "not_entitled", "not_found"]);

/**
 * Delivers one outbox row to the consumers registered for its event (design §5.5): each consumer is a
 * durable step with retries; once all ran the row is marked dispatched. A consumer that already has
 * a row in `kernel.outbox_deliveries` is not run again. The entitlement resolver (`moduleGate`) decides per consumer module, and every
 * consumer of the event is tried before the row's fate is decided (Task 52.1, Ruling R52-1):
 * - a module the company switched off is skipped silently; after the loop the row stays undispatched with
 *   `last_error = 'module_disabled'`, its claim released (design §5.12). This wins over a never-bought module: the park is deferred,
 *   the row is re-dispatched once the module is switched on and meets the never-bought one again;
 * - otherwise a module the tenant never bought (an explicit consumer, not `"*"` nor a `kernel.*` event, which are skipped silently)
 *   dead-letters the row as `not_entitled:<module id>` without running that consumer, after the other consumers ran, so it stays
 *   visible on Admin › Módulos (owner 2026-11-06) and its `delivered_modules` hold every consumer that ran: a replay once the module is
 *   bought runs only that one, and Descartar loses nothing for the others (owner 2026-11-08, items 47 and 52). With two never-bought
 *   modules the row parks under the first; once that one is bought and replayed, it parks under the second (Ruling R52-2);
 * - otherwise the row is marked dispatched.
 * A `FatalError`, or a consumer that keeps failing after its retries, sends the row to `kernel.outbox_dead_letter` with its message at
 * once. A worker with no modules loaded fails the run instead, leaving the row undispatched (its claim lapses and a worker that has the
 * modules picks it up).
 */
export async function dispatchOutboxRow(outboxId: string): Promise<void> {
  "use workflow";

  const row = await loadOutboxRow(outboxId);
  if (row === null) return; // already dispatched, or gone
  const moduleIds = await consumersFor(outboxId, row.event);

  let paused = false;
  let unentitled: string | null = null;
  for (const moduleId of moduleIds) {
    try {
      const result = await runConsumer(outboxId, moduleId);
      if (result === "module_disabled") paused = true;
      else if (result === "not_purchased") unentitled ??= moduleId;
    } catch (error) {
      await deadLetter(outboxId, error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (paused) await pauseRow(outboxId);
  else if (unentitled !== null) await deadLetter(outboxId, `not_entitled:${unentitled}`);
  else await markDispatched(outboxId);
}

/** The row to dispatch, or null when it is already dispatched or no longer exists. */
async function loadOutboxRow(outboxId: string): Promise<OutboxRow | null> {
  "use step";
  return readRow(outboxId);
}

/**
 * Ids of the modules that consume `event`, in registration order. A process that loaded no modules
 * would find none and the row would be marked dispatched with its event lost, so that fails (and is
 * retried) instead, with the cause in the row's `last_error`.
 */
async function consumersFor(outboxId: string, event: string): Promise<string[]> {
  "use step";
  if (registry.modules().length === 0) {
    await recordFailure(getServiceDb(), outboxId, "outbox: no modules loaded in worker");
    throw new RetryableError("outbox: no modules loaded in worker", { retryAfter: retryDelay() });
  }
  return consumers.for(event).map((c) => c.moduleId);
}

/**
 * Runs the consumer `moduleId` registered for the row's event, then records its delivery. Does nothing
 * when the delivery is already recorded, and returns `module_disabled` when the company has the
 * module switched off and `not_purchased` when the tenant never bought it (the consumer does not run). A failure counts an attempt and is retried with backoff; a `FatalError`, or a
 * process refusal that cannot change (`invalid_input`, `forbidden`, `not_entitled`, `not_found`), is not.
 */
async function runConsumer(outboxId: string, moduleId: string): Promise<ConsumerResult> {
  "use step";
  const sql = getServiceDb();
  const row = await readRow(outboxId);
  if (row === null) return "done";

  const [delivered] = await sql`select 1 from kernel.outbox_deliveries where outbox_id = ${outboxId} and module_id = ${moduleId}`;
  if (delivered) return "done";

  const gate = await moduleGate(sql, row.companyId, moduleId);
  if (gate === "switched_off") return "module_disabled";
  if (gate === "not_purchased") {
    // A module the tenant never bought is skipped silently, as before, for its `"*"` (posting) consumer and for the platform's own
    // `kernel.*` events: every company emits events and none of them is a failure of the module it does not have. Only an explicit
    // consumer of another module's event dead-letters, visibly (owner 2026-11-06, decision item 9).
    if (consumers.isWildcard(row.event, moduleId) || row.event.startsWith("kernel.")) return "done";
    return "not_purchased";
  }

  const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId);
  if (!consumer) throw new FatalError(`no consumer of ${moduleId} registered for ${row.event}`);

  try {
    await consumer.fn(buildConsumerContext(sql, row), row.payload);
  } catch (error) {
    if (FatalError.is(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ProcessError && DETERMINISTIC.has(error.code)) throw new FatalError(`${error.code}: ${message}`);
    await recordFailure(sql, outboxId, message);
    throw new RetryableError(message, { retryAfter: retryDelay() });
  }
  await sql`insert into kernel.outbox_deliveries (outbox_id, module_id) values (${outboxId}, ${moduleId}) on conflict do nothing`;
  return "done";
}

/** Exponential backoff by step attempt: 1 s, 2 s, 4 s ... capped at 60 s. */
function retryDelay(): number {
  return Math.min(2 ** (getStepMetadata().attempt - 1), 60) * 1000;
}

/** Counts a failed attempt on the row and keeps the cause. */
async function recordFailure(sql: Sql, outboxId: string, message: string): Promise<void> {
  await sql`update kernel.outbox set attempts = attempts + 1, last_error = ${message} where id = ${outboxId}`;
}

/** Parks a row whose consumer module is disabled: marks it and releases the claim so it is picked up once enabled. */
async function pauseRow(outboxId: string): Promise<void> {
  "use step";
  await getServiceDb()`
    update kernel.outbox set last_error = 'module_disabled', claimed_at = null where id = ${outboxId} and dispatched_at is null`;
}

/** Sets `dispatched_at` and clears a `module_disabled` marker; `last_error` of earlier retries is kept. */
async function markDispatched(outboxId: string): Promise<void> {
  "use step";
  await getServiceDb()`
    update kernel.outbox
    set dispatched_at = now(), last_error = case when last_error = 'module_disabled' then null else last_error end
    where id = ${outboxId} and dispatched_at is null`;
}

/** Moves the row to `kernel.outbox_dead_letter` (same id, `failed_at = now()`, `last_error = error`), keeping the modules that had handled it (`delivered_modules`, restored on a replay). */
async function deadLetter(outboxId: string, error: string): Promise<void> {
  "use step";
  await getServiceDb()`
    with moved as (delete from kernel.outbox where id = ${outboxId} returning *)
    insert into kernel.outbox_dead_letter (id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, last_error, failed_at, delivered_modules)
    select id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, ${error}, now(),
           coalesce((select array_agg(d.module_id) from kernel.outbox_deliveries d where d.outbox_id = moved.id), '{}')
    from moved`;
}

async function readRow(outboxId: string): Promise<OutboxRow | null> {
  const [row] = await getServiceDb()<{ id: string; created_at: Date; company_id: string; event: string; payload: JSONValue; chain_id: string }[]>`
    select id, created_at, company_id, event, payload, chain_id from kernel.outbox where id = ${outboxId} and dispatched_at is null`;
  return row ? { id: row.id, createdAt: row.created_at, companyId: row.company_id, event: row.event, payload: row.payload, chainId: row.chain_id } : null;
}
