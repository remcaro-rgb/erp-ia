import { defineProcess, type AccountSeed, type ProcessContext } from "@erp/kernel";
import { z } from "zod";
import { companyPack, requireAdmin } from "./common";
import { openFiscalYear } from "./fiscal-year";
import { syncDefaultRules } from "./posting-rule";

// accounting.chart.seed (accounting design §5.9, §6): installs the country's chart, role mappings, fuentes, concept mappings,
// the settings row, the fiscal year of today and the default posting rules from the pack and the loaded modules. Additive
// and idempotent: it only inserts what is missing and never overwrites what the company edited.

const output = z.object({ accounts: z.number(), mappings: z.number(), journals: z.number(), rules: z.number(), year: z.number() });

/** Rows inserted per statement (the parent trigger of an account reads the accounts inserted before it, so parents go first). */
const BATCH = 500;

async function seedAccounts(ctx: ProcessContext, seeds: AccountSeed[], levelOf: (code: string) => string | null): Promise<number> {
  const existing = new Set((await ctx.tx<{ code: string }[]>`select code from accounting.accounts where company_id = ${ctx.companyId}`).map((r) => r.code));
  const missing = seeds.filter((s) => !existing.has(s.code)).sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
  // A code that is a proper prefix of another seed has children: only leaves at subaccount or auxiliary level take movements (§4.1).
  const prefixes = new Set<string>();
  for (const s of [...seeds, ...existing].map((x) => (typeof x === "string" ? x : x.code))) for (let i = 1; i < s.length; i++) prefixes.add(s.slice(0, i));
  for (let i = 0; i < missing.length; i += BATCH) {
    const rows = missing.slice(i, i + BATCH);
    // Batches never mix lengths out of order, but a batch may span lengths: the sort keeps every parent before its children.
    await ctx.tx`insert into accounting.accounts ${ctx.tx(
      rows.map((s) => ({
        company_id: ctx.companyId,
        code: s.code,
        name: s.name,
        nature: s.nature,
        allows_movement: ["subaccount", "auxiliary"].includes(levelOf(s.code) ?? "") && !prefixes.has(s.code),
        requires_party: s.requiresParty,
        requires_cost_center: s.requiresCostCenter,
        statement_section: s.statementSection ?? null,
        is_opening_result: s.isOpeningResult,
      })),
    )}`;
  }
  return missing.length;
}

export const chartSeed = defineProcess({
  id: "accounting.chart.seed",
  module: "accounting",
  kind: "create",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Configura la contabilidad de la empresa: plan de cuentas, mapeo de roles, fuentes, conceptos de exógena, año fiscal y reglas contables por defecto; solo agrega lo que falta",
  input: z.object({}),
  output,
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const pack = await companyPack(ctx);

    const accounts = await seedAccounts(ctx, [...pack.chartOfAccounts(), ...pack.extraAccounts()], (code) => {
      const check = pack.validateAccountCode(code);
      return check.ok ? check.level : null;
    });

    // Fuentes
    const haveJournals = new Set((await ctx.tx<{ code: string }[]>`select code from accounting.journals where company_id = ${ctx.companyId}`).map((r) => r.code));
    const newJournals = pack.defaultJournals().filter((j) => !haveJournals.has(j.code));
    if (newJournals.length > 0) {
      await ctx.tx`insert into accounting.journals ${ctx.tx(newJournals.map((j) => ({ company_id: ctx.companyId, code: j.code, name: j.name, kind: j.kind, manual_entries: j.manualEntries })))}`;
    }

    const idByCode = new Map((await ctx.tx<{ id: string; code: string }[]>`select id, code from accounting.accounts where company_id = ${ctx.companyId}`).map((a) => [a.code, a.id]));

    // Role mappings (role, dimension) → account
    const haveRoles = new Set((await ctx.tx<{ k: string }[]>`select role || '|' || coalesce(dimension, '') as k from accounting.account_role_mappings where company_id = ${ctx.companyId}`).map((r) => r.k));
    const roleRows = pack.defaultRoleMappings()
      .filter((m) => idByCode.has(m.code) && !haveRoles.has(`${m.role}|${m.dimension ?? ""}`))
      .map((m) => ({ company_id: ctx.companyId, role: m.role, dimension: m.dimension ?? null, account_id: idByCode.get(m.code)! }));
    if (roleRows.length > 0) await ctx.tx`insert into accounting.account_role_mappings ${ctx.tx(roleRows)}`;

    // Exógena concept mappings: one concept per account and format
    const haveConcepts = new Set((await ctx.tx<{ k: string }[]>`select format || '|' || account_id as k from accounting.fiscal_concept_mappings where company_id = ${ctx.companyId}`).map((r) => r.k));
    const conceptRows = pack.defaultConceptMappings()
      .filter((m) => idByCode.has(m.code) && !haveConcepts.has(`${m.format}|${idByCode.get(m.code)!}`))
      .map((m) => ({ company_id: ctx.companyId, format: m.format, concept: m.concept, account_id: idByCode.get(m.code)! }));
    if (conceptRows.length > 0) await ctx.tx`insert into accounting.fiscal_concept_mappings ${ctx.tx(conceptRows)}`;

    // Settings: the ledger starts today, manual entries go to NC
    const [nc] = await ctx.tx<{ id: string }[]>`select id from accounting.journals where company_id = ${ctx.companyId} and code = 'NC'`;
    await ctx.tx`
      insert into accounting.settings (company_id, ledger_starts_on, manual_journal_id)
      values (${ctx.companyId}, current_date, ${nc?.id ?? null})
      on conflict (company_id) do nothing`;

    // The fiscal year of today
    const [today] = await ctx.tx<{ y: number }[]>`select extract(year from current_date)::int as y`;
    const [haveYear] = await ctx.tx<{ n: number }[]>`select count(*)::int as n from accounting.fiscal_years where company_id = ${ctx.companyId} and year = ${today!.y}`;
    let year = 0;
    if (haveYear!.n === 0) {
      await openFiscalYear(ctx, pack, today!.y);
      year = 1;
    }

    // Default posting rules the loaded modules ship, accounting's own included (design §5.4)
    const rules = await syncDefaultRules(ctx);

    return { accounts, mappings: roleRows.length + conceptRows.length, journals: newJournals.length, rules, year };
  },
});

export const CHART_PROCESSES = [chartSeed];
