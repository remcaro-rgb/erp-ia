import type { JSONValue } from "postgres";
import type { Tx } from "../db/client";

export interface OutboxEvent {
  companyId: string;
  /** Typed event name such as `sales.order.confirmed` (design §5.5). */
  event: string;
  payload: unknown;
  chainId: string;
}

/**
 * Writes an undispatched event to `kernel.outbox` in the caller's transaction, so the event exists
 * if and only if the state change it describes was committed. Returns the new outbox id.
 */
export async function enqueueEvent(tx: Tx, evt: OutboxEvent): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into kernel.outbox (company_id, event, payload, chain_id)
    values (${evt.companyId}, ${evt.event}, ${tx.json(evt.payload as JSONValue)}, ${evt.chainId})
    returning id`;
  return row!.id;
}
