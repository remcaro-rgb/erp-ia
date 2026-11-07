import type { ModuleGate } from "@erp/kernel";

// What a document's record frame says about its posting (Task 33, R33-8), from the rows of `accounting.pending_postings` and the posting module's gate.
// Pure, so the mapping is unit-tested without a database.

/** Why a document waits outside the retry queue: the posting module is switched off for the company, or the tenant never bought it (Task 50.9 states). */
export type ParkedReason = "accounting_disabled" | "not_entitled";

export interface PendingPosting {
  /** `queued` waits for the consumer; `failed` is in the retry queue (`failureId`); `parked` waits for the module (`reason`); `dead` was dead-lettered before accounting handled it (replayed from Admin › Módulos). */
  state: "queued" | "failed" | "parked" | "dead";
  reason?: ParkedReason;
  failureId?: string;
}

export interface PendingRow {
  source_id: string;
  state: string;
  failure_id: string | null;
}

const REASON: Record<Exclude<ModuleGate, "enabled">, ParkedReason> = { switched_off: "accounting_disabled", not_purchased: "not_entitled" };

/**
 * One entry per source document that has something pending. A failure wins over a dead letter, and both over a queued event of the same document (the ones the user can act on). `pending_postings` answers `queued` also for an event parked because accounting is off or not bought: while the gate is not `enabled` those rows
 * are `parked`, with the reason of the gate.
 */
export function pendingByDocument(rows: readonly PendingRow[], gate: ModuleGate): Map<string, PendingPosting> {
  const out = new Map<string, PendingPosting>();
  for (const row of rows) {
    if (row.state === "failed" && row.failure_id) {
      out.set(row.source_id, { state: "failed", failureId: row.failure_id });
    } else if (row.state === "dead" && out.get(row.source_id)?.state !== "failed") {
      out.set(row.source_id, { state: "dead" });
    } else if (row.state === "queued" && !["failed", "dead"].includes(out.get(row.source_id)?.state ?? "")) {
      out.set(row.source_id, gate === "enabled" ? { state: "queued" } : { state: "parked", reason: REASON[gate] });
    }
  }
  return out;
}
