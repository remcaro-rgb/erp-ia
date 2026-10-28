import type { JSONValue } from "postgres";
import type { Tx } from "../db/client";

/** Where a change came from (rule 16). `db` is a direct database edit caught by a row trigger. */
export type Origin = "ui" | "agent" | "scheduler" | "event" | "api" | "db";

export type AuditAction = "insert" | "update" | "delete" | "consult";

export interface AuditEntry {
  companyId: string;
  actorUserId: string;
  origin: Origin;
  processId?: string;
  entity: string;
  rowId?: string;
  action: AuditAction;
  input?: unknown;
  /** Column-level before/after summary: `{ column: { old, new } }`. */
  diff?: unknown;
  /** Causal chain id shared by every step of one user request. */
  chainId: string;
  conversationId?: string;
  agentRunId?: string;
}

export interface AuditContext {
  origin: Origin;
  processId?: string;
  chainId: string;
  actorUserId: string;
  conversationId?: string;
}

/** Appends a process-level entry to `kernel.audit_log` inside the caller's transaction. */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx`
    insert into kernel.audit_log
      (company_id, actor_user_id, origin, process_id, entity, row_id, action, input, diff, chain_id, conversation_id, agent_run_id)
    values (
      ${entry.companyId}, ${entry.actorUserId}, ${entry.origin}, ${entry.processId ?? null}, ${entry.entity},
      ${entry.rowId ?? null}, ${entry.action},
      ${entry.input === undefined ? null : tx.json(entry.input as JSONValue)},
      ${entry.diff === undefined ? null : tx.json(entry.diff as JSONValue)},
      ${entry.chainId}, ${entry.conversationId ?? null}, ${entry.agentRunId ?? null})`;
}

/**
 * Tells the row-change trigger who is writing for the rest of this transaction (`set_config(..., true)`),
 * so rows changed by a process carry its origin, process id and causal chain instead of `db`.
 */
export async function setAuditContext(tx: Tx, ctx: AuditContext): Promise<void> {
  await tx`
    select
      set_config('erp.audit_origin', ${ctx.origin}, true),
      set_config('erp.audit_process_id', ${ctx.processId ?? ""}, true),
      set_config('erp.audit_chain_id', ${ctx.chainId}, true),
      set_config('erp.audit_actor_user_id', ${ctx.actorUserId}, true),
      set_config('erp.audit_conversation_id', ${ctx.conversationId ?? ""}, true)`;
}
