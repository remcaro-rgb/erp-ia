import type { ProcessContext } from "../process/context";
import type { ConsumerContext } from "../registry/types";
import type { ComposedEntry } from "./compose";
import type { RuleTemplate } from "./template";

export type PostingFailureCode =
  | "unbalanced" | "missing_account_mapping" | "closed_period" | "inactive_account" | "missing_party" | "missing_cost_center"
  | "missing_open_auxiliary" | "missing_item" | "missing_business_unit" | "inactive_dimension" | "invalid_template" | "no_journal";

export interface PostingRule { id: string; event: string; journalId: string; template: RuleTemplate; priority: number }
export interface ResolvedAccount { accountId: string; code: string }
export interface PostingFailure { eventId: string; event: string; eventDate: string; ruleId?: string; payload: unknown; code: PostingFailureCode; detail: string }
/** A rule a module ships; the provider seeds it per company (design §5.4). */
export interface DefaultPostingRule { event: string; name: string; journalCode: string; template: RuleTemplate; priority?: number }

/** What a module implements to receive the engine's output; the kernel knows no module (design §5.1). */
export interface PostingProvider {
  rulesFor(ctx: ConsumerContext, event: string): Promise<PostingRule[]>;
  resolveAccount(ctx: ConsumerContext, role: string, dimension?: string): Promise<ResolvedAccount | null>;
  ledgerStartsOn(ctx: ConsumerContext): Promise<Date | null>;
  /**
   * Runs the provider's own process; `rule` gives the idempotency key `posting:<event_id>:<rule_id>` and the journal. `entryId` is null when
   * the event was dismissed meanwhile (its source voided before it posted, `kernel.dismiss_events`): nothing was written.
   */
  post(ctx: ConsumerContext, draft: ComposedEntry, rule: PostingRule): Promise<{ entryId: string | null }>;
  /** The company's `rounding_tolerance` and currency, which composition needs (design §4.11, §10a.8). */
  composeSettings(ctx: ConsumerContext): Promise<{ tolerance: number; companyCurrency: string }>;
  /** Counts an event acknowledged without posting because it predates the ledger ("eventos anteriores al inicio del libro"). */
  countSkipped(ctx: ConsumerContext, eventId: string): Promise<void>;
  reverse(ctx: ConsumerContext, ref: { event: string; sourceId: string }): Promise<{ entryId: string } | null>;
  recordFailure(ctx: ConsumerContext, failure: PostingFailure): Promise<void>;
  /**
   * What a run that emits `event` will post, one line per rule ("Contabilidad: asiento en Ventas"), for a confirmation card (design §5.1).
   * With the event's `payload` (a dry run's), a rule whose `when` does not hold on it is left out; without one, every rule with a `when`
   * is (the card cannot tell whether it applies).
   */
  effectsFor(ctx: ConsumerContext, event: string, payload?: unknown): Promise<string[]>;
  /**
   * Events the engine must not compose at all, whatever rules exist (Phase 2A.5 Task 8b): the provider's own lifecycle events,
   * such as the `<entity>.ready_to_post` the typed lifecycle emits while it already posts that document in the same run. An ignored
   * event is neither posted, nor counted as skipped, nor recorded as a failure.
   */
  ignores?(event: string): boolean;
  /**
   * Inline strict posting (entity types spec §5.2, D8): posts the composed entry of `rule` NOW, in the caller's transaction, as the
   * caller, and answers the entry; answers the first entry when `(draft.sourceEventId, rule)` already posted. A refusal (a closed period,
   * a missing party…) throws a `ProcessError` whose message leads with the failure code, so the surrounding run rolls back. It records
   * no posting failure. Used by `emitAndPostStrict` for a documento that posts (contabiliza).
   */
  postInline?(ctx: ProcessContext, draft: ComposedEntry, rule: PostingRule): Promise<{ entryId: string }>;
  /** Inline strict reversal of the entry `ref` names, dated `date`; null when nothing was posted for the source; throws when it cannot be reversed. */
  reverseInline?(ctx: ProcessContext, ref: { event: string; sourceId: string }, date: string, eventName: string): Promise<{ entryId: string } | null>;
}
