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
  post(ctx: ConsumerContext, draft: ComposedEntry): Promise<{ entryId: string }>;
  reverse(ctx: ConsumerContext, ref: { event: string; sourceId: string }): Promise<{ entryId: string } | null>;
  recordFailure(ctx: ConsumerContext, failure: PostingFailure): Promise<void>;
  effectsFor(ctx: ConsumerContext, event: string): Promise<string[]>;
}
