import type { Sql } from "postgres";
import { entitlementLimit } from "@erp/kernel";

// The company's monthly AI token allowance (rule 27, design §5.12, §20): `limit:ai_tokens_month` from the entitlements
// (the starter plan grants 2,000,000), against the tokens metered in `kernel.llm_usage` this calendar month in the
// company's time zone. Over it, a turn answers `errors.ai_budget_exceeded` and makes no model call; that refusal is
// phase 1's form of rule 27's "consult questions only" (no model call at all, so nothing is spent past the cap).
//
// Prices: the table lives in the kernel (`MODEL_PRICES`) because the kernel meters embeddings too (the help search and
// the help index build) and cannot depend on this package; it is re-exported here with the cost function.

export { costUsd, DEFAULT_PRICE, MODEL_PRICES, priceOf } from "@erp/kernel";
export type { ModelPrice } from "@erp/kernel";

export const AI_TOKENS_LIMIT_KEY = "limit:ai_tokens_month";

export interface TokenBudget {
  allowed: boolean;
  /** Input plus output tokens metered this calendar month (company time zone), embeddings included. */
  used: number;
  /** Null: the company has no allowance configured, so no cap applies. */
  limit: number | null;
}

/** Over budget once the month's tokens reach the limit; no limit, no cap. */
export const overBudget = (used: number, limit: number | null): boolean => limit !== null && used >= limit;

/** The company's allowance and what it used this month. Service connection (`entitlementLimit` is service-only). */
export async function checkTokenBudget(sql: Sql, companyId: string): Promise<TokenBudget> {
  const limit = await entitlementLimit(sql, companyId, AI_TOKENS_LIMIT_KEY);
  const [row] = await sql<{ used: string }[]>`
    select coalesce(sum(u.input_tokens + u.output_tokens), 0)::bigint as used
    from kernel.companies c
    join kernel.llm_usage u on u.company_id = c.id
    where c.id = ${companyId}
      and u.created_at >= (date_trunc('month', now() at time zone c.timezone) at time zone c.timezone)`;
  const used = Number(row?.used ?? 0);
  return { allowed: !overBudget(used, limit), used, limit };
}
