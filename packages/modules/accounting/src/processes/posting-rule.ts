import { composeEntry, defineProcess, ProcessError, RuleTemplate, type ComposedLine, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { defined, invalid } from "./common";
import { knownRoles, resolveRoleAccount } from "./mapping";
import { id, idOutput } from "./schemas";

// Reglas contables (accounting design §4.8, §5.6): per-company copies of the rules modules ship. Changing them changes where
// every future event posts, so create, update and disable run under step-up; `posting_rule.test` previews a rule on a past event.

const ruleBody = {
  event: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  journalId: z.uuid(),
  template: z.unknown(),
  priority: z.number().int().min(0).max(10_000).optional(),
  isActive: z.boolean().optional(),
};

/** A template the kernel schema accepts whose roles are known; the refusal lists every problem in Spanish. */
function checkTemplate(ctx: ProcessContext, template: unknown): RuleTemplate {
  const parsed = RuleTemplate.safeParse(template);
  if (!parsed.success) {
    throw new ProcessError("invalid_input", "invalid_template: the rule template is not valid", { details: parsed.error.issues.map((i) => `${i.path.join(".") || "plantilla"}: ${i.message}`) });
  }
  const roles = new Set(knownRoles(ctx));
  const unknown = parsed.data.lines.filter((l) => l.role && !roles.has(l.role)).map((l) => `El rol contable ${l.role} no existe`);
  if (unknown.length > 0) throw new ProcessError("invalid_input", "invalid_template: unknown role", { details: unknown });
  return parsed.data;
}

async function requireJournal(ctx: ProcessContext, journalId: string): Promise<void> {
  const [journal] = await ctx.tx<{ is_active: boolean; code: string }[]>`select is_active, code from accounting.journals where id = ${journalId} and company_id = ${ctx.companyId}`;
  if (!journal) throw invalid(`journal ${journalId} not found`, "La fuente indicada no existe");
  if (!journal.is_active) throw invalid(`journal ${journal.code} is inactive`, `La fuente ${journal.code} está inactiva`);
}

const json = (ctx: ProcessContext, value: unknown) => ctx.tx.json(value as Parameters<typeof ctx.tx.json>[0]);

export const postingRuleCreate = defineProcess({
  id: "accounting.posting_rule.create",
  module: "accounting",
  kind: "create",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Crea una regla contable propia de la empresa: un evento, una fuente y una plantilla declarativa de líneas",
  input: z.object({ ...ruleBody }).strict(),
  output: idOutput,
  handler: async (ctx, input) => {
    const template = checkTemplate(ctx, input.template);
    await requireJournal(ctx, input.journalId);
    const [row] = await ctx.tx<{ id: string }[]>`
      insert into accounting.posting_rules ${ctx.tx({
        company_id: ctx.companyId, event: input.event, name: input.name, description: input.description ?? null, journal_id: input.journalId,
        template: json(ctx, template), priority: input.priority ?? 100, is_active: input.isActive ?? true,
      })}
      returning id`;
    return { id: row!.id };
  },
});

export const postingRuleUpdate = defineProcess({
  id: "accounting.posting_rule.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Modifica una regla contable; una regla que trajo un módulo queda marcada como modificada por la empresa",
  input: z.object({ id, ...Object.fromEntries(Object.entries(ruleBody).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) } as { id: typeof id } & { [K in keyof typeof ruleBody]: z.ZodOptional<(typeof ruleBody)[K]> }).strict(),
  output: idOutput,
  handler: async (ctx, { id: ruleId, ...input }) => {
    const [current] = await ctx.tx<{ id: string }[]>`select id from accounting.posting_rules where id = ${ruleId} and company_id = ${ctx.companyId} for update`;
    if (!current) throw new ProcessError("not_found", `posting rule ${ruleId} not found`);
    const template = input.template === undefined ? undefined : checkTemplate(ctx, input.template);
    if (input.journalId) await requireJournal(ctx, input.journalId);
    const set = defined({
      event: input.event, name: input.name, description: input.description, journal_id: input.journalId,
      template: template === undefined ? undefined : json(ctx, template), priority: input.priority, is_active: input.isActive,
    });
    if (Object.keys(set).length > 0) await ctx.tx`update accounting.posting_rules set ${ctx.tx({ ...set, is_modified: true })} where id = ${ruleId}`;
    return { id: ruleId };
  },
});

export const postingRuleDisable = defineProcess({
  id: "accounting.posting_rule.disable",
  module: "accounting",
  kind: "update",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Desactiva una regla contable: los eventos siguientes dejan de generar su comprobante",
  input: z.object({ id }).strict(),
  output: idOutput,
  handler: async (ctx, { id: ruleId }) => {
    const rows = await ctx.tx`update accounting.posting_rules set is_active = false, is_modified = true where id = ${ruleId} and company_id = ${ctx.companyId} returning id`;
    if (rows.length === 0) throw new ProcessError("not_found", `posting rule ${ruleId} not found`);
    return { id: ruleId };
  },
});

export const postingRuleTest = defineProcess({
  id: "accounting.posting_rule.test",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Simula una regla contable sobre un evento pasado de la empresa y devuelve el comprobante que produciría, sin contabilizar nada",
  input: z.object({ ruleId: z.uuid(), outboxId: z.uuid() }).strict(),
  output: z.looseObject({ ok: z.boolean() }),
  handler: async (ctx, { ruleId, outboxId }) => {
    const [rule] = await ctx.tx<{ id: string; template: unknown }[]>`select id, template from accounting.posting_rules where id = ${ruleId} and company_id = ${ctx.companyId}`;
    if (!rule) throw new ProcessError("not_found", `posting rule ${ruleId} not found`);
    const [event] = await ctx.tx<{ id: string; event: string; payload: unknown; created_at: Date; chain_id: string }[]>`
      select id, event, payload, created_at, chain_id from kernel.outbox where id = ${outboxId} and company_id = ${ctx.companyId}`;
    if (!event) throw new ProcessError("not_found", `event ${outboxId} not found`);
    const [settings] = await ctx.tx<{ rounding_tolerance: string }[]>`select rounding_tolerance from accounting.settings where company_id = ${ctx.companyId}`;
    const template = RuleTemplate.parse(rule.template);
    if (template.reverseOf) {
      return { ok: true, reverseOf: template.reverseOf, event: event.event };
    }
    const composed = composeEntry(template, { id: event.id, event: event.event, payload: event.payload, createdAt: event.created_at, chainId: event.chain_id }, {
      tolerance: Number(settings?.rounding_tolerance ?? 0), companyCurrency: "COP",
    });
    if (!composed.ok) return { ok: false, code: composed.code, detail: composed.detail };
    const lines: ComposedLine[] = [];
    for (const line of composed.entry.lines) {
      if (line.accountCode || !line.role) {
        lines.push(line);
        continue;
      }
      const account = (line.dimension ? await resolveRoleAccount(ctx, line.role, line.dimension) : null) ?? (await resolveRoleAccount(ctx, line.role));
      if (!account) return { ok: false, code: "missing_account_mapping", detail: `Sin cuenta para el rol ${line.role}${line.dimension ? `:${line.dimension}` : ""}` };
      lines.push({ ...line, accountCode: account.code });
    }
    return { ok: true, entry: { ...composed.entry, lines } };
  },
});

/** Copies every loaded module's default rules into the company where the (event, name) is missing; never touches an existing or modified rule. */
export async function syncDefaultRules(ctx: ProcessContext): Promise<number> {
  let inserted = 0;
  for (const module of ctx.registry.modules()) {
    for (const rule of module.postingRules ?? []) {
      const [journal] = await ctx.tx<{ id: string }[]>`select id from accounting.journals where company_id = ${ctx.companyId} and code = ${rule.journalCode}`;
      if (!journal) throw invalid(`rule ${rule.name} names journal ${rule.journalCode}`, `La regla "${rule.name}" usa la fuente ${rule.journalCode}, que no existe`);
      const [have] = await ctx.tx<{ n: number }[]>`
        select count(*)::int as n from accounting.posting_rules where company_id = ${ctx.companyId} and event = ${rule.event} and name = ${rule.name}`;
      if (have!.n > 0) continue;
      await ctx.tx`
        insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
        values (${ctx.companyId}, ${rule.event}, ${rule.name}, ${module.id}, ${journal.id}, ${json(ctx, rule.template)}, ${rule.priority ?? 100}, true)`;
      inserted++;
    }
  }
  return inserted;
}

export const postingRuleSyncDefaults = defineProcess({
  id: "accounting.posting_rule.sync_defaults",
  module: "accounting",
  kind: "update",
  feature: "accounting.posting",
  description: "Copia a la empresa las reglas contables por defecto de los módulos cargados que aún no tiene; nunca toca las existentes ni las modificadas",
  input: z.object({}).strict(),
  output: z.object({ inserted: z.number() }),
  handler: async (ctx) => ({ inserted: await syncDefaultRules(ctx) }),
});

export const POSTING_RULE_PROCESSES = [postingRuleCreate, postingRuleUpdate, postingRuleDisable, postingRuleTest, postingRuleSyncDefaults];
