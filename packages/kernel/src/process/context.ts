import type { AuditEntry, Origin } from "../audit/audit";
import type { JwtClaims, Tx } from "../db/client";
import type { RecommendationsApi } from "../home/recommend";
import type { LinksApi } from "../links/links";
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
  /**
   * Runs `fn` once the run's transaction has committed (never after a refusal, a rollback or a dry run), before runProcess returns,
   * in registration order. It is for effects outside the database that must only happen once the run is recorded (Notificar sends
   * its mail after its log row is committed, Task 12). `asCaller` opens a new transaction as the caller, with the run's audit context.
   * An error it throws is logged and the caller still gets the committed result (the next steps still run). Absent on contexts that
   * are not a runProcess run.
   */
  /**
   * Runs another registered process inside this run's transaction, as the same caller (nested run). It goes through the gates that
   * can be asked inside a transaction: the process must be entitled, allow this origin, be runnable by the caller (`kernel.can_run_process`,
   * menu access included), parse its input and pass the record-level guard. Its writes are attributed to the nested process (its id in
   * the row audit and its own audit entry, same chain, same actor and origin); the events it emits go on the same chain. It runs without
   * an idempotency key. The company's admin configures it per pair (parent → nested process, plan 2B Task 32, migration 0126); with no
   * configuration it behaves as follows, and each default can be widened:
   *   - depth: a root run is depth 0 and a run nested `max_depth` levels deep (default 4, at most 8) may not nest again (`handler_failed`);
   *   - step-up: a nested process that needs a step-up is refused with `step_up_required`, unless the pair lets the parent's TOTP cover it
   *     and this run consumed a fresh verification of this user (the parent is itself step-up);
   *   - failure: a refusal or failure propagates, and so rolls back the whole outer run. A pair set to `continue` runs the nested process
   *     inside a savepoint: a handler failure, a SQL error, `invalid_input` or `not_found` undoes the nested run only (its writes, audit,
   *     events, links and afterCommit steps), is queued in `kernel.nested_run_failures` and this call resolves **`undefined`**; a denial
   *     always propagates, and so does any failure of a process that posts to the ledger or moves stock (the registry says which).
   * An outer handler that catches a propagated error and goes on writes as the outer process again, but outside a `continue` pair the
   * nested run's writes before its failure stay in the transaction (and after a SQL error the transaction is aborted).
   * `opts.asParent` evaluates the pair, `nestedOnlyFrom` and the permission as if `asParent` were the parent; only the queue's retry
   * (`kernel.nested_failure.retry`) may pass it (`forbidden` otherwise), and such a run always rolls back on failure. Absent on contexts that
   * are not a runProcess run.
   */
  runProcess?<T = unknown>(processId: string, input: unknown, opts?: { asParent?: string }): Promise<T | undefined>;
  /**
   * Raises or closes a recommendation of this process for the people who can act on it (design §22.28, plan 2B Task 38): written in the
   * run's transaction under this process's name (a nested run writes under its own), refused for a consult. A dry run's rows roll back with
   * it. Absent on contexts that are not a runProcess run.
   */
  recommendations?: RecommendationsApi;
  /**
   * Writes the document links of this process's document (design §22.27, plan 2B Task 31): `sync` sets the links of one kind into a
   * document of this process's module, `markVoided` marks every link of a document it voids. In the run's transaction under this
   * process's name (a nested run writes under its own), refused for a consult or a delete; each link carries the run's chain. A dry run's
   * rows roll back with it. Absent on contexts that are not a runProcess run.
   */
  links?: LinksApi;
  afterCommit?(fn: (asCaller: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>) => Promise<void>): void;
}
