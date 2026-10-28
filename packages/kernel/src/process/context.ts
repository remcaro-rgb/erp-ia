import type { AuditEntry, Origin } from "../audit/audit";
import type { JwtClaims, Tx } from "../db/client";
import type { Registry } from "../registry";

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
  /** The registry this run resolved the process from, for handlers that must know a registered entity. */
  registry: Registry;
  companyId: string;
  tenantId: string;
  userId: string;
  /** The caller's roles in the company that they still hold (`kernel.current_role_ids()`, read in the run's transaction). */
  roleIds: string[];
  locale: string;
  origin: Origin;
  chainId: string;
  conversationId?: string;
  /**
   * True in a dry run (`runProcess(…, { dryRun: true })`): the transaction is rolled back after the handler, so every
   * effect of the handler must stay inside `tx`. A handler that would reach outside the database (a provider call,
   * a stored file, an e-mail) must skip it when this is set.
   */
  dryRun: boolean;
  /** Writes a domain event to the outbox in the process transaction, on the process chain. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Writes an extra audit entry in the process transaction; unset fields default to the process's. */
  audit(entry: Partial<AuditEntry>): Promise<void>;
}
