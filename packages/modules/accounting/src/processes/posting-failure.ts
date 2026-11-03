import { composeEntry, defineProcess, ProcessError, RuleTemplate, visibleExtra, type ComposedLine } from "@erp/kernel";
import { z } from "zod";
import { invalid } from "./common";
import { resolveRoleAccount } from "./mapping";
import { postFromEvent, type ComposedInput } from "./post-from-event";
import { id, rowOutput } from "./schemas";

// The inbox of events that could not post (accounting design §4.9, §5.5): retry re-runs the rule on the stored payload, dismiss
// closes the row with a reason, consult lists them.

interface FailureRow {
  id: string;
  event_id: string;
  event: string;
  posting_rule_id: string | null;
  payload: unknown;
  status: string;
  created_at: Date;
  attempts: number;
}

const codeOf = (error: ProcessError): string => {
  const lead = error.message.split(":")[0] ?? "";
  return /^[a-z_]+$/.test(lead) ? lead : "invalid_template";
};

export const postingRetry = defineProcess({
  id: "accounting.posting.retry",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  description: "Reintenta una regla contable sobre el evento guardado de un pendiente, con la misma clave de idempotencia; si ya cuadra, lo marca como resuelto",
  emits: ["accounting.entry.posted"],
  input: z.object({ failureId: id }).strict(),
  output: z.object({ resolved: z.boolean(), entryId: z.string().optional(), number: z.string().optional(), code: z.string().optional(), detail: z.string().optional() }),
  handler: async (ctx, { failureId }) => {
    const [failure] = await ctx.tx<FailureRow[]>`
      select id, event_id, event, posting_rule_id, payload, status, created_at, attempts
      from accounting.posting_failures where id = ${failureId} and company_id = ${ctx.companyId} for update`;
    if (!failure) throw new ProcessError("not_found", `posting failure ${failureId} not found`);
    if (failure.status !== "pending") throw invalid(`failure ${failureId} is ${failure.status}`, "Este pendiente ya está resuelto o descartado");
    if (!failure.posting_rule_id) throw invalid(`failure ${failureId} has no rule`, "El pendiente no tiene una regla contable que reintentar");
    const [rule] = await ctx.tx<{ id: string; template: unknown; is_active: boolean }[]>`
      select id, template, is_active from accounting.posting_rules where id = ${failure.posting_rule_id} and company_id = ${ctx.companyId}`;
    if (!rule) throw new ProcessError("not_found", `posting rule ${failure.posting_rule_id} not found`);
    if (!rule.is_active) throw invalid(`rule ${rule.id} is disabled`, "La regla contable está desactivada");

    const fail = async (code: string, detail: string) => {
      await ctx.tx`
        update accounting.posting_failures set error_code = ${code}, error_detail = ${detail}, attempts = attempts + 1, last_attempt_at = now() where id = ${failureId}`;
      return { resolved: false, code, detail };
    };
    const [settings] = await ctx.tx<{ rounding_tolerance: string }[]>`select rounding_tolerance from accounting.settings where company_id = ${ctx.companyId}`;
    const template = RuleTemplate.safeParse(rule.template);
    if (!template.success) return fail("invalid_template", template.error.issues.map((i) => i.message).join("; "));
    const composed = composeEntry(template.data, { id: failure.event_id, event: failure.event, payload: failure.payload, createdAt: failure.created_at, chainId: ctx.chainId }, {
      tolerance: Number(settings?.rounding_tolerance ?? 0), companyCurrency: "COP",
    });
    if (!composed.ok) return fail(composed.code, composed.detail);
    const lines: ComposedLine[] = [];
    for (const line of composed.entry.lines) {
      if (line.accountCode || !line.role) {
        lines.push(line);
        continue;
      }
      const account = (line.dimension ? await resolveRoleAccount(ctx, line.role, line.dimension) : null) ?? (await resolveRoleAccount(ctx, line.role));
      if (!account) return fail("missing_account_mapping", `Sin cuenta para el rol ${line.role}${line.dimension ? `:${line.dimension}` : ""}`);
      lines.push({ ...line, accountCode: account.code });
    }

    // The attempt runs in a savepoint: a refusal undoes the half-written entry and is recorded on the row instead of rolling the whole run back.
    try {
      const posted = await ctx.tx.savepoint((sp) =>
        postFromEvent({ ...ctx, tx: sp }, { entry: { ...composed.entry, lines } as unknown as ComposedInput, ruleId: rule.id, eventId: failure.event_id }),
      );
      await ctx.tx`
        update accounting.posting_failures
           set status = 'resolved', resolved_entry_id = ${posted.id}, attempts = attempts + 1, last_attempt_at = now()
         where id = ${failureId}`;
      return { resolved: true, entryId: posted.id, number: posted.number };
    } catch (error) {
      if (error instanceof ProcessError && error.code === "invalid_input") return fail(codeOf(error), Array.isArray(error.details) && error.details.length > 0 ? error.details.join("; ") : error.message);
      throw error;
    }
  },
});

export const postingFailureDismiss = defineProcess({
  id: "accounting.posting_failure.dismiss",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  description: "Descarta un pendiente de contabilizar indicando el motivo; el evento no se contabilizará",
  input: z.object({ failureId: id, reason: z.string().trim().min(1).max(500) }).strict(),
  output: z.object({ id: z.string() }),
  handler: async (ctx, { failureId, reason }) => {
    const rows = await ctx.tx`
      update accounting.posting_failures
         set status = 'dismissed', extra = extra || ${ctx.tx.json({ dismiss_reason: reason })}
       where id = ${failureId} and company_id = ${ctx.companyId} and status = 'pending'
       returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `pending failure ${failureId} not found`);
    return { id: failureId };
  },
});

export const postingFailureConsult = defineProcess({
  id: "accounting.posting_failure.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta un pendiente de contabilizar por su id, o lista los pendientes por estado",
  input: z.object({ id: id.optional(), status: z.enum(["pending", "resolved", "dismissed"]).optional(), limit: z.number().int().min(1).max(200).default(50) }).strict(),
  output: rowOutput.or(z.looseObject({ failures: z.array(z.looseObject({})) })),
  handler: async (ctx, input) => {
    if (input.id) {
      const [row] = await ctx.tx`select * from accounting.v_posting_failures where id = ${input.id}`;
      if (!row) throw new ProcessError("not_found", `posting failure ${input.id} not found`);
      return { ...row, id: input.id, extra: await visibleExtra(ctx, "accounting.posting_failure", row.extra) };
    }
    const failures = await ctx.tx`
      select * from accounting.v_posting_failures where (${input.status ?? null}::text is null or status = ${input.status ?? null})
      order by created_at desc limit ${input.limit}`;
    return { failures };
  },
});

export const POSTING_FAILURE_PROCESSES = [postingRetry, postingFailureDismiss, postingFailureConsult];
