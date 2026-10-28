import { z } from "zod";
import type { Tx } from "../db/client";
import { defineProcess } from "../process/define";
import { ADMIN_FEATURE, requireAdmin } from "./common";

// The company's AI usage for a calendar month (design §20.2, rule 27): the tokens and the cost metered in
// kernel.llm_usage per user and per model, against the monthly allowance `limit:ai_tokens_month` (when it is reached the
// assistant answers without the model). Months are the company's time zone, as the allowance check counts them.

const MONTH = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Mes en formato AAAA-MM");

const usageOutput = z.object({
  month: z.string(),
  /** Tokens allowed in the month; null when no allowance is configured (no cap). */
  limit: z.number().nullable(),
  /** Input plus output tokens of the month, embeddings included. */
  used: z.number(),
  costUsd: z.number(),
  users: z.array(
    z.object({ userId: z.string().nullable(), name: z.string().nullable(), email: z.string().nullable(), tokens: z.number(), calls: z.number(), costUsd: z.number() }),
  ),
  models: z.array(z.object({ task: z.string(), model: z.string(), tokens: z.number(), calls: z.number(), costUsd: z.number() })),
});

export type AiUsage = z.infer<typeof usageOutput>;

/**
 * The company's usage in `month` (`AAAA-MM`, the current month by default), read in `tx` as the caller: the admin reads
 * every row of the company (the llm_usage policy), anyone else only their own. The consult process and the AI usage
 * page share it.
 */
export async function readAiUsage(tx: Tx, companyId: string, month?: string): Promise<AiUsage> {
  // The month's bounds in the company's time zone; the current month by default.
  const [bounds] = await tx<{ month: string; starts: Date; ends: Date }[]>`
    with c as (select timezone from kernel.companies where id = ${companyId}),
    m as (
      select coalesce(to_date(${month ?? null}, 'YYYY-MM'), date_trunc('month', now() at time zone c.timezone)::date) as first, c.timezone
      from c
    )
    select to_char(m.first, 'YYYY-MM') as month,
           (m.first::timestamp at time zone m.timezone) as starts,
           ((m.first + interval '1 month')::timestamp at time zone m.timezone) as ends
    from m`;
  const { month: label, starts, ends } = bounds!;
  const users = await tx<{ user_id: string | null; name: string | null; email: string | null; tokens: string; calls: string; cost: string }[]>`
    select u.user_id, p.full_name as name, p.email,
           sum(u.input_tokens + u.output_tokens) as tokens, count(*) as calls, sum(u.cost_usd) as cost
    from kernel.llm_usage u
    left join kernel.users p on p.id = u.user_id
    where u.company_id = ${companyId} and u.created_at >= ${starts} and u.created_at < ${ends}
    group by u.user_id, p.full_name, p.email
    order by sum(u.input_tokens + u.output_tokens) desc, p.full_name`;
  const models = await tx<{ task: string; model: string; tokens: string; calls: string; cost: string }[]>`
    select task, model, sum(input_tokens + output_tokens) as tokens, count(*) as calls, sum(cost_usd) as cost
    from kernel.llm_usage
    where company_id = ${companyId} and created_at >= ${starts} and created_at < ${ends}
    group by task, model
    order by sum(input_tokens + output_tokens) desc`;
  const [limit] = await tx<{ value: string | null }[]>`select kernel.company_limit('limit:ai_tokens_month') as value`;
  const round = (usd: number) => Math.round(usd * 1_000_000) / 1_000_000;
  const userRows = users.map((u) => ({ userId: u.user_id, name: u.name, email: u.email, tokens: Number(u.tokens), calls: Number(u.calls), costUsd: round(Number(u.cost)) }));
  return {
    month: label,
    limit: limit?.value == null ? null : Number(limit.value),
    used: userRows.reduce((sum, u) => sum + u.tokens, 0),
    costUsd: round(users.reduce((sum, u) => sum + Number(u.cost), 0)),
    users: userRows,
    models: models.map((m) => ({ task: m.task, model: m.model, tokens: Number(m.tokens), calls: Number(m.calls), costUsd: round(Number(m.cost)) })),
  };
}

export const aiUsageConsult = defineProcess({
  id: "kernel.admin.ai_usage.consult",
  module: "kernel",
  kind: "consult",
  feature: ADMIN_FEATURE,
  sensitivity: "step-up",
  description: "Consulta el uso de IA del mes de la empresa: tokens y costo por usuario y por modelo frente al tope mensual",
  input: z.object({ month: MONTH.optional() }),
  output: usageOutput,
  handler: async (ctx, input) => {
    await requireAdmin(ctx);
    return readAiUsage(ctx.tx, ctx.companyId, input.month);
  },
});

export const USAGE_PROCESSES = [aiUsageConsult];
