import "server-only";
import { moduleGate, withClaims, type Caller } from "@erp/kernel";
import { processDeps } from "@/lib/server/runtime";
import { pendingByDocument, type PendingPosting, type PendingRow } from "./pending-state";

export type { ParkedReason, PendingPosting } from "./pending-state";

// What the record frame of a contabiliza documento (invoice, note, receipt, landed cost) shows when its entry is not in the ledger yet (Task 33,
// R33-8): the rows of `accounting.v_pending_postings` (migration 0129, over the function `accounting.pending_postings`) for the document, read as the caller (the function reveals no ledger data, only that a posting is
// pending, so it needs no accounting permission), and the posting module's gate to tell an event waiting for the consumer from one parked because
// accounting is switched off or not bought (Task 50.9). It clears by itself: nothing is edited on the document.

/** The pending posting of each of `sourceIds` that has one (a document with nothing pending is not in the map). Never rejects: a failing read is a frame without the badge. */
export async function loadPendingPostings(caller: Caller, sourceIds: readonly string[]): Promise<Map<string, PendingPosting>> {
  if (sourceIds.length === 0) return new Map();
  const deps = processDeps();
  try {
    const rows = await withClaims(deps.sql, caller.claims, (tx) =>
      tx<PendingRow[]>`select source_id, state, failure_id from accounting.v_pending_postings where source_id = any(${[...sourceIds]}::uuid[])`,
    );
    if (rows.length === 0) return new Map();
    return pendingByDocument(rows, await moduleGate(deps.sql, caller.claims.active_company_id, "accounting"));
  } catch (error) {
    console.error("pending postings failed", error);
    return new Map();
  }
}
