import { composeEntry, defineProcess, moduleStates, ProcessError, RuleTemplate, ruleApplies, visibleExtra, type ComposedLine, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { defined, invalid } from "./common";
import { knownRoles, resolveRoleAccount } from "./mapping";
import { id, idOutput, rowOutput } from "./schemas";

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
  recordAccess: "none",
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
  recordAccess: "none",
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

export const postingRuleConsult = defineProcess({
  id: "accounting.posting_rule.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta una regla contable con su plantilla, su fuente y si la empresa la modificó",
  input: z.object({ id }).strict(),
  output: rowOutput,
  handler: async (ctx, { id: ruleId }) => {
    const [row] = await ctx.tx`
      select r.*, j.code as journal_code, j.name as journal_name
      from accounting.v_posting_rules r left join accounting.v_journals j on j.id = r.journal_id
      where r.id = ${ruleId}`;
    if (!row) throw new ProcessError("not_found", `posting rule ${ruleId} not found`);
    return { ...row, id: ruleId, stale: await ruleIsStale(ctx, ruleId), extra: await visibleExtra(ctx, "accounting.posting_rule", row.extra) };
  },
});

/** Most recent events of the rule's event read per rule when deciding it is stale (plan 50.6, ruling R50-6). */
export const STALE_SCAN_CAP = 5000;

/**
 * Stale (Task 50.6): an active rule with a non-empty `when`, older than N days (`accounting.settings.rule_stale_days`), for which no
 * `kernel.outbox` row of its event created in the last N days satisfies `ruleApplies`. The scan reads at most STALE_SCAN_CAP rows, newest
 * first, so on a very busy event it is a heuristic. Reads the table as the company's rule check, not the caller's view: the answer is a
 * boolean about the company's own events, never their content.
 */
async function ruleIsStale(ctx: ProcessContext, ruleId: string): Promise<boolean> {
  const [rule] = await ctx.tx<{ event: string; template: unknown; is_active: boolean; old_enough: boolean }[]>`
    select r.event, r.template, r.is_active,
           greatest(r.created_at, r.updated_at) <= now() - make_interval(days => coalesce(s.rule_stale_days, 30)) as old_enough
    from accounting.posting_rules r left join accounting.settings s on s.company_id = r.company_id
    where r.id = ${ruleId} and r.company_id = ${ctx.companyId}`;
  if (!rule || !rule.is_active || !rule.old_enough) return false;
  // The raw jsonb, as the engine reads it: the template schema does not list `when`, so a parse would drop it.
  const template = rule.template as RuleTemplate;
  const when = (template as { when?: unknown[] }).when;
  if (!Array.isArray(when) || when.length === 0) return false;
  // Only the top-level payload keys the `when` paths start with leave the database (paths are `$.a.b`, checked by ruleApplies).
  const keys = [...new Set((when as { path?: unknown }[]).map((c) => (typeof c?.path === "string" ? c.path.split(".")[1]?.replace(/\[\*\]$/, "") : undefined)).filter((k): k is string => !!k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)))];
  const events = await ctx.tx<{ payload: unknown }[]>`
    select (select coalesce(jsonb_object_agg(k, o.payload -> k) filter (where o.payload ? k), '{}'::jsonb) from unnest(${keys}::text[]) as k) as payload
    from (
      select payload from kernel.outbox
      where company_id = ${ctx.companyId} and event = ${rule.event}
        and created_at > now() - make_interval(days => coalesce((select rule_stale_days from accounting.settings where company_id = ${ctx.companyId}), 30))
      order by created_at desc limit ${STALE_SCAN_CAP}
    ) o`;
  for (const event of events) {
    try {
      if (ruleApplies(template, event.payload)) return false;
    } catch {
      // A malformed condition applies to nothing; the engine records it when the event posts.
    }
  }
  return true;
}

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

export interface PostingRuleSync { inserted: number; activated: number; deactivated: number }

/**
 * Installs, for the active company, the `postingRules` of every module enabled for it (accounting design §5.4, plan 2B Task 1).
 * Additive: a rule is added where its (event, name) is missing and nothing existing is rewritten. A module's default rule the admin
 * never touched follows its module: inactive while the module is off (never deleted), active again when it is on. A rule the admin
 * modified or disabled (`is_modified`) keeps its template and its state. A company without fuentes yet (the chart is not seeded) gets
 * nothing; `chart.seed` runs this again.
 */
export async function syncPostingRules(ctx: ProcessContext): Promise<PostingRuleSync> {
  const out: PostingRuleSync = { inserted: 0, activated: 0, deactivated: 0 };
  const [seeded] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from accounting.journals where company_id = ${ctx.companyId}`;
  if (seeded!.n === 0) return out;
  const enabled = new Set((await moduleStates(ctx.tx, ctx.registry)).filter((m) => m.enabled).map((m) => m.id));
  for (const module of ctx.registry.modules()) {
    if (!module.postingRules || module.postingRules.length === 0) continue;
    if (!enabled.has(module.id)) {
      const off = await ctx.tx`
        update accounting.posting_rules set is_active = false
        where company_id = ${ctx.companyId} and module = ${module.id} and is_default and not is_modified and is_active returning id`;
      out.deactivated += off.length;
      continue;
    }
    const on = await ctx.tx`
      update accounting.posting_rules set is_active = true
      where company_id = ${ctx.companyId} and module = ${module.id} and is_default and not is_modified and not is_active returning id`;
    out.activated += on.length;
    for (const rule of module.postingRules) {
      const [journal] = await ctx.tx<{ id: string }[]>`select id from accounting.journals where company_id = ${ctx.companyId} and code = ${rule.journalCode}`;
      if (!journal) throw invalid(`rule ${rule.name} names journal ${rule.journalCode}`, `La regla "${rule.name}" usa la fuente ${rule.journalCode}, que no existe`);
      const [have] = await ctx.tx<{ n: number }[]>`
        select count(*)::int as n from accounting.posting_rules where company_id = ${ctx.companyId} and event = ${rule.event} and name = ${rule.name}`;
      if (have!.n > 0) continue;
      await ctx.tx`
        insert into accounting.posting_rules (company_id, event, name, module, journal_id, template, priority, is_default)
        values (${ctx.companyId}, ${rule.event}, ${rule.name}, ${module.id}, ${journal.id}, ${json(ctx, rule.template)}, ${rule.priority ?? 100}, true)`;
      out.inserted++;
    }
  }
  out.deactivated += await retireSupersededRules(ctx);
  return out;
}

/**
 * Default rules a later version split or replaced (accounting design §5.4): the old one's (event, name) and the names that replace it. The
 * sync adds the new rules by their (event, name), so a company still holding the old copy would post both (final review I-1: the note rule
 * of 2A split by migration 0098).
 */
const SUPERSEDED_RULES: readonly { event: string; name: string; by: readonly string[] }[] = [
  { event: "invoicing.note.issued", name: "Nota crédito o débito de venta", by: ["Nota crédito de anulación de venta", "Nota crédito de venta", "Nota débito de venta"] },
];

/**
 * Keeps exactly one effective set where a company has both an old default rule and every rule that replaces it (the same as migration
 * 0115, so the order of the sync and the migrations never matters): an old copy nobody touched is retired (inactive and marked modified, as
 * an admin's disable, so the sync never activates it again; never deleted, entries may reference it); an old copy the admin modified and
 * left active keeps posting, and the replacing rules the admin never touched are set inactive and marked modified for the admin to review
 * (as 0098 adds them). Answers how many rules it deactivated.
 */
async function retireSupersededRules(ctx: ProcessContext): Promise<number> {
  let deactivated = 0;
  for (const old of SUPERSEDED_RULES) {
    const [state] = await ctx.tx<{ replacing: number; untouched: number; modified_active: number }[]>`
      select (select count(distinct name)::int from accounting.posting_rules
               where company_id = ${ctx.companyId} and event = ${old.event} and name = any(${old.by as string[]}::text[])) as replacing,
             count(*) filter (where is_default and not is_modified and not (template ? 'when'))::int as untouched,
             count(*) filter (where is_modified and is_active)::int as modified_active
      from accounting.posting_rules where company_id = ${ctx.companyId} and event = ${old.event} and name = ${old.name}`;
    if (!state || state.replacing < old.by.length) continue;
    if (state.modified_active > 0) {
      const off = await ctx.tx`
        update accounting.posting_rules set is_active = false, is_modified = true
        where company_id = ${ctx.companyId} and event = ${old.event} and name = any(${old.by as string[]}::text[]) and is_default and not is_modified
        returning is_active`;
      deactivated += off.length;
    }
    if (state.untouched > 0) {
      const off = await ctx.tx<{ was_active: boolean }[]>`
        update accounting.posting_rules r set is_active = false, is_modified = true
        from (select id, is_active as was_active from accounting.posting_rules
              where company_id = ${ctx.companyId} and event = ${old.event} and name = ${old.name} and is_default and not is_modified and not (template ? 'when')
              for update) o
        where r.id = o.id
        returning o.was_active`;
      deactivated += off.filter((r) => r.was_active).length;
    }
  }
  return deactivated;
}

export const postingRuleSync = defineProcess({
  id: "accounting.posting_rule.sync",
  module: "accounting",
  kind: "create",
  recordAccess: "none",
  feature: "accounting.posting",
  // Event-only: kernel.module.enabled triggers it; it is neither a button nor a tool, and the sensitive-processes page leaves it out.
  origins: ["event"],
  description: "Instala en la empresa las reglas contables de los módulos activos que aún no tiene y pone al día las de los módulos apagados; nunca toca las que la empresa modificó",
  input: z.object({}).strict(),
  output: z.object({ inserted: z.number(), activated: z.number(), deactivated: z.number() }),
  handler: (ctx) => syncPostingRules(ctx),
});

export const postingRuleSyncDefaults = defineProcess({
  id: "accounting.posting_rule.sync_defaults",
  module: "accounting",
  kind: "update",
  recordAccess: "none",
  feature: "accounting.posting",
  description: "Copia a la empresa las reglas contables por defecto de los módulos activos que aún no tiene; nunca toca las existentes ni las modificadas",
  input: z.object({}).strict(),
  output: z.object({ inserted: z.number() }),
  handler: async (ctx) => ({ inserted: (await syncPostingRules(ctx)).inserted }),
});

export const POSTING_RULE_PROCESSES = [postingRuleCreate, postingRuleUpdate, postingRuleDisable, postingRuleConsult, postingRuleTest, postingRuleSync, postingRuleSyncDefaults];
