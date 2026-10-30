import { defineProcess, type AccountingPack, type ExogenaFormat } from "@erp/kernel";
import { z } from "zod";
import { companyPack, invalid } from "./common";
import { id } from "./schemas";

// Exógena concept mappings (accounting design §4.13, §6): which accounts feed which DIAN concept of each format. The catalogue
// of formats and concepts belongs to the country pack (rule 5); this module stores the company's account → concept choice.
// Editing it changes the figures reported to the DIAN, so the update runs under step-up.

/** The formats of the catalogue of tax year `year`, or null when the pack ships none for it. */
function formatsOf(pack: AccountingPack, year: number): ExogenaFormat[] | null {
  try {
    return pack.exogenaFormats(year);
  } catch {
    return null;
  }
}

export const fiscalConceptMappingUpdate = defineProcess({
  id: "accounting.fiscal_concept_mapping.update",
  module: "accounting",
  kind: "update",
  feature: "accounting.posting",
  sensitivity: "step-up",
  description: "Asigna cuentas a los conceptos de información exógena de cada formato; una cuenta pertenece a un solo concepto por formato",
  input: z.object({
    mappings: z.array(z.object({ format: z.string().trim().min(1), concept: z.string().trim().min(1), accountId: id, isActive: z.boolean().optional() }).strict()).min(1).max(500),
  }).strict(),
  output: z.object({ upserted: z.number() }),
  handler: async (ctx, { mappings }) => {
    const pack = await companyPack(ctx);
    const [today] = await ctx.tx<{ y: number }[]>`select extract(year from current_date)::int as y`;
    // The catalogue of the current tax year, else the previous one (a mapping outlives the year it was made in).
    const catalogue = formatsOf(pack, today!.y) ?? formatsOf(pack, today!.y - 1);
    if (!catalogue) throw invalid("no exogena catalogue", "El país no tiene catálogo de información exógena para este año");
    const seen = new Set<string>();
    for (const m of mappings) {
      const format = catalogue.find((f) => f.format === m.format);
      if (!format) throw invalid(`unknown format ${m.format}`, `El formato ${m.format} no existe en el catálogo de exógena`);
      if (!format.concepts.some((c) => c.code === m.concept)) throw invalid(`unknown concept ${m.concept}`, `El concepto ${m.concept} no existe en el formato ${m.format}`);
      const key = `${m.format}|${m.accountId}`;
      if (seen.has(key)) throw invalid(`account mapped twice in ${m.format}`, `Una cuenta solo puede estar en un concepto por formato (formato ${m.format})`);
      seen.add(key);
    }
    for (const m of mappings) {
      const [account] = await ctx.tx<{ id: string }[]>`select id from accounting.accounts where id = ${m.accountId} and company_id = ${ctx.companyId}`;
      if (!account) throw invalid(`account ${m.accountId} not found`, "La cuenta indicada no existe");
      await ctx.tx`
        insert into accounting.fiscal_concept_mappings (company_id, format, concept, account_id, is_active)
        values (${ctx.companyId}, ${m.format}, ${m.concept}, ${m.accountId}, ${m.isActive ?? true})
        on conflict (company_id, format, account_id)
        do update set concept = excluded.concept, is_active = coalesce(${m.isActive ?? null}, accounting.fiscal_concept_mappings.is_active)`;
    }
    return { upserted: mappings.length };
  },
});

export const fiscalConceptMappingConsult = defineProcess({
  id: "accounting.fiscal_concept_mapping.consult",
  module: "accounting",
  kind: "consult",
  feature: "accounting.posting",
  description: "Consulta los conceptos de un formato de exógena con sus cuentas y las cuentas con movimiento en el año que ningún concepto cubre",
  input: z.object({ format: z.string().trim().min(1), year: z.number().int().min(2000).max(2100) }).strict(),
  output: z.object({
    format: z.string(),
    year: z.number(),
    concepts: z.array(z.object({ code: z.string(), label: z.string(), accounts: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), isActive: z.boolean() })) })),
    unmapped: z.array(z.object({ accountId: z.string(), code: z.string(), name: z.string(), movement: z.number() })),
  }),
  handler: async (ctx, { format: formatId, year }) => {
    const pack = await companyPack(ctx);
    const catalogue = formatsOf(pack, year);
    if (!catalogue) throw invalid(`no exogena catalogue for ${year}`, `No hay catálogo de exógena para el año gravable ${year}`);
    const format = catalogue.find((f) => f.format === formatId);
    if (!format) throw invalid(`unknown format ${formatId}`, `El formato ${formatId} no existe en el catálogo de exógena de ${year}`);

    const mapped = await ctx.tx<{ concept: string; id: string; code: string; name: string; is_active: boolean }[]>`
      select m.concept, a.id, a.code, a.name, m.is_active
      from accounting.fiscal_concept_mappings m join accounting.v_accounts a on a.id = m.account_id
      where m.company_id = ${ctx.companyId} and m.format = ${formatId}
      order by a.code`;

    // Accounts with movement in the year on the side the format reports whose own code or an ancestor's code is mapped (active)
    // are covered; the rest are unmapped. Restricted accounts the caller may not view are left out (design §5.13).
    const side = format.side;
    const unmapped = await ctx.tx<{ id: string; code: string; name: string; movement: string }[]>`
      with moved as (
        select l.account_id,
               sum(case ${side} when 'debit' then l.debit when 'credit' then l.credit else l.debit + l.credit end) as movement
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id
        where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed')
          and e.date >= make_date(${year}, 1, 1) and e.date <= make_date(${year}, 12, 31)
        group by l.account_id
      )
      select a.id, a.code, a.name, m.movement
      from moved m join accounting.accounts a on a.id = m.account_id
      where m.movement > 0
        and accounting.can_view_account(a.id)
        and not exists (
          select 1 from accounting.fiscal_concept_mappings c join accounting.accounts mapped on mapped.id = c.account_id
          where c.company_id = ${ctx.companyId} and c.format = ${formatId} and c.is_active and a.code like mapped.code || '%'
        )
      order by a.code`;

    return {
      format: formatId,
      year,
      concepts: format.concepts.map((c) => ({
        code: c.code,
        label: c.label,
        accounts: mapped.filter((m) => m.concept === c.code).map((m) => ({ id: m.id, code: m.code, name: m.name, isActive: m.is_active })),
      })),
      unmapped: unmapped.map((u) => ({ accountId: u.id, code: u.code, name: u.name, movement: Number(u.movement) })),
    };
  },
});

export const CONCEPT_MAPPING_PROCESSES = [fiscalConceptMappingUpdate, fiscalConceptMappingConsult];
