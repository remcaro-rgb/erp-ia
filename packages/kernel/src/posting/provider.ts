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
  /** Runs the provider's own process; `rule` gives the idempotency key `posting:<event_id>:<rule_id>` and the journal. */
  post(ctx: ConsumerContext, draft: ComposedEntry, rule: PostingRule): Promise<{ entryId: string }>;
  /** The company's `rounding_tolerance` and currency, which composition needs (design §4.11, §10a.8). */
  composeSettings(ctx: ConsumerContext): Promise<{ tolerance: number; companyCurrency: string }>;
  /** Counts an event acknowledged without posting because it predates the ledger ("eventos anteriores al inicio del libro"). */
  countSkipped(ctx: ConsumerContext, eventId: string): Promise<void>;
  reverse(ctx: ConsumerContext, ref: { event: string; sourceId: string }): Promise<{ entryId: string } | null>;
  recordFailure(ctx: ConsumerContext, failure: PostingFailure): Promise<void>;
  effectsFor(ctx: ConsumerContext, event: string): Promise<string[]>;
  /**
   * Events the engine must not compose at all, whatever rules exist (Phase 2A.5 Task 8b): the provider's own lifecycle events,
   * such as the `<entity>.ready_to_post` the typed lifecycle emits while it already posts that document in the same run. An ignored
   * event is neither posted, nor counted as skipped, nor recorded as a failure.
   */
  ignores?(event: string): boolean;
}
