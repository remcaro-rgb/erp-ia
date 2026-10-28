import type { AuditEntry, Origin } from "../audit/audit";
import type { JwtClaims, Tx } from "../db/client";

/** Who runs a process and from where: the user's claims, also when the assistant or a job acts for them. */
export interface Caller {
  claims: JwtClaims;
  origin: Origin;
  conversationId?: string;
  /** Token of a fresh step-up verification by this user, required by sensitive processes. */
  stepUpToken?: string;
  /** Causal chain to join; a new one is started when absent. */
  chainId?: string;
}

/** What a handler receives: the process transaction (RLS as the caller) and the caller's identity. */
export interface ProcessContext {
  tx: Tx;
  companyId: string;
  tenantId: string;
  userId: string;
  roleIds: string[];
  locale: string;
  origin: Origin;
  chainId: string;
  conversationId?: string;
  /** Writes a domain event to the outbox in the process transaction, on the process chain. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Writes an extra audit entry in the process transaction; unset fields default to the process's. */
  audit(entry: Partial<AuditEntry>): Promise<void>;
}
