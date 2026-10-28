import { FatalError, RetryableError, getStepMetadata } from "workflow";
import type { JSONValue } from "postgres";
import { getServiceDb } from "../db/service";
import { buildConsumerContext, consumers } from "./consumers";

interface OutboxRow {
  companyId: string;
  event: string;
  payload: unknown;
  chainId: string;
}

type ConsumerResult = "done" | "module_disabled";

/**
 * Delivers one outbox row to the consumers registered for its event (design §5.5): each consumer is a
 * durable step with retries; once all ran the row is marked dispatched. A consumer of a module the
 * company disabled is skipped and the row stays undispatched with `last_error = 'module_disabled'`
 * (design §5.12). A `FatalError`, or a consumer that keeps failing after its retries, sends the row to
 * `kernel.outbox_dead_letter`.
 */
export async function dispatchOutboxRow(outboxId: string): Promise<void> {
  "use workflow";

  const row = await loadOutboxRow(outboxId);
  if (row === null) return; // already dispatched, or gone
  const moduleIds = await consumersFor(row.event);

  let paused = false;
  for (const moduleId of moduleIds) {
    try {
      if ((await runConsumer(outboxId, moduleId)) === "module_disabled") paused = true;
    } catch (error) {
      await deadLetter(outboxId, error instanceof Error ? error.message : String(error));
      return;
    }
  }
  if (!paused) await markDispatched(outboxId);
}

/** The row to dispatch, or null when it is already dispatched or no longer exists. */
async function loadOutboxRow(outboxId: string): Promise<OutboxRow | null> {
  "use step";
  return readRow(outboxId);
}

/** Ids of the modules that consume `event`, in registration order. */
async function consumersFor(event: string): Promise<string[]> {
  "use step";
  return consumers.for(event).map((c) => c.moduleId);
}

/**
 * Runs the consumer `moduleId` registered for the row's event. Skipped (and the row marked
 * `module_disabled`) when the company has the module disabled. A failure counts an attempt and is
 * retried with backoff; a `FatalError` is not retried.
 */
async function runConsumer(outboxId: string, moduleId: string): Promise<ConsumerResult> {
  "use step";
  const sql = getServiceDb();
  const row = await readRow(outboxId);
  if (row === null) return "done";

  const [gate] = await sql<{ enabled: boolean }[]>`
    select enabled from kernel.company_modules where company_id = ${row.companyId} and module_id = ${moduleId}`;
  if (gate && !gate.enabled) {
    await sql`update kernel.outbox set last_error = 'module_disabled' where id = ${outboxId} and dispatched_at is null`;
    return "module_disabled";
  }

  const consumer = consumers.for(row.event).find((c) => c.moduleId === moduleId);
  if (!consumer) throw new FatalError(`no consumer of ${moduleId} registered for ${row.event}`);

  try {
    await consumer.fn(buildConsumerContext(sql, row), row.payload);
  } catch (error) {
    if (FatalError.is(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    await sql`update kernel.outbox set attempts = attempts + 1, last_error = ${message} where id = ${outboxId}`;
    const { attempt } = getStepMetadata();
    throw new RetryableError(message, { retryAfter: Math.min(2 ** attempt, 60) * 1000 });
  }
  return "done";
}

/** Sets `dispatched_at` and clears a `module_disabled` marker; `last_error` of earlier retries is kept. */
async function markDispatched(outboxId: string): Promise<void> {
  "use step";
  await getServiceDb()`
    update kernel.outbox
    set dispatched_at = now(), last_error = case when last_error = 'module_disabled' then null else last_error end
    where id = ${outboxId} and dispatched_at is null`;
}

/** Moves the row to `kernel.outbox_dead_letter` (same id, `failed_at = now()`, `last_error = error`). */
async function deadLetter(outboxId: string, error: string): Promise<void> {
  "use step";
  await getServiceDb()`
    with moved as (delete from kernel.outbox where id = ${outboxId} returning *)
    insert into kernel.outbox_dead_letter (id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, last_error, failed_at)
    select id, company_id, event, payload, chain_id, created_at, dispatched_at, attempts, ${error}, now() from moved`;
}

async function readRow(outboxId: string): Promise<OutboxRow | null> {
  const [row] = await getServiceDb()<{ company_id: string; event: string; payload: JSONValue; chain_id: string }[]>`
    select company_id, event, payload, chain_id from kernel.outbox where id = ${outboxId} and dispatched_at is null`;
  return row ? { companyId: row.company_id, event: row.event, payload: row.payload, chainId: row.chain_id } : null;
}
