import { defineProcess, defineReport, ProcessError, type ExogenaFormat, type ExogenaRow, type ProcessContext, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { cents, reportInput, reportOutput, windowOf } from "./common";

// Información exógena (accounting design §5.11, §4.13): for each party and concept, the year's movement of the accounts the concept
// mapping names (descendants included), on the side the format reports. The opposite side counts only for reversals and credit
// notes. Opening and year-close entries never count in movement formats and always count in the balance formats. Parties under the
// format's threshold are added up under the pack's cuantías-menores NIT. Whatever blocks the file is listed in `errors`.

const params = z.object({ year: z.number().int().min(2000).max(2100), format: z.string().trim().min(1), threshold: z.number().min(0).optional() });
export type ExogenaParams = z.infer<typeof params>;

const MAX_COLUMNS = 3;
const columns: ReportColumn[] = [
  { field: "concept", label: "report.col.concept", type: "text", mono: true },
  { field: "concept_label", label: "report.col.concept_label", type: "text" },
  { field: "party_document_type", label: "report.col.document_type", type: "text", mono: true },
  { field: "party_document", label: "report.col.party_document", type: "text", mono: true, link: { entity: "core.party", idField: "party_id" } },
  { field: "party_name", label: "report.col.party", type: "text" },
  ...Array.from({ length: MAX_COLUMNS }, (_, i) => ({ field: `col${i + 1}`, label: `report.col.value_${i + 1}`, type: "money" as const, total: "sum" as const, mono: true })),
];

interface PartyInfo {
  id: string;
  document_type: string | null;
  document_number: string | null;
  check_digit: string | null;
  legal_name: string | null;
  department_code: string | null;
  municipality_code: string | null;
  country_code: string | null;
}

export interface ExogenaData {
  format: ExogenaFormat;
  rows: Record<string, unknown>[];
  exogenaRows: ExogenaRow[];
  errors: string[];
}

const bump = (values: Record<string, number>, id: string, by: number): void => {
  values[id] = (values[id] ?? 0) + by;
};

const UNIDENTIFIED_TYPE = "43";
const CUANTIAS_NAME = "CUANTÍAS MENORES";

/** The year's exógena rows of one format, with the errors that stop the file. */
export async function exogenaData(ctx: ProcessContext, year: number, formatId: string, thresholdOverride?: number): Promise<ExogenaData> {
  const pack = await companyPack(ctx);
  let formats: ExogenaFormat[];
  try {
    formats = pack.exogenaFormats(year);
  } catch (error) {
    throw new ProcessError("invalid_input", `no exogena catalogue for ${year}`, { details: [error instanceof Error ? error.message : `No hay catálogo de exógena para el año ${year}`] });
  }
  const format = formats.find((f) => f.format === formatId);
  if (!format) throw new ProcessError("invalid_input", `unknown format ${formatId}`, { details: [`El formato ${formatId} no existe en el catálogo de exógena de ${year}`] });
  const threshold = thresholdOverride ?? format.threshold;
  const errors: string[] = [];
  const columnIds = format.columns.map((c) => c.id);
  const first = `${year}-01-01`;
  const last = `${year}-12-31`;

  // value per (concept, party, column)
  const cells = new Map<string, { concept: string; partyId: string; values: Record<string, number> }>();
  const cell = (concept: string, partyId: string) => {
    const key = `${concept}|${partyId}`;
    let entry = cells.get(key);
    if (!entry) cells.set(key, (entry = { concept, partyId, values: Object.fromEntries(columnIds.map((id) => [id, 0])) }));
    return entry;
  };

  const mappings = await ctx.tx<{ concept: string; code: string }[]>`
    select m.concept, a.code from accounting.fiscal_concept_mappings m join accounting.accounts a on a.id = m.account_id
    where m.company_id = ${ctx.companyId} and m.format = ${formatId} and m.is_active`;
  const codes = mappings.map((m) => m.code);
  const concepts = mappings.map((m) => m.concept);

  if (mappings.length > 0 && format.side === "balance") {
    const lines = await ctx.tx<{ concept: string; party_id: string | null; entry: string | null; line_no: number; code: string; balance: string }[]>`
      with mapped as (select * from unnest(${concepts}::text[], ${codes}::text[]) as t(concept, mcode)),
      raw as (
        select distinct on (l.id) mp.concept, l.party_id, e.number as entry, l.line_no, a.code,
               case when a.nature = 'debit' then l.debit - l.credit else l.credit - l.debit end as balance
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
        join mapped mp on a.code like mp.mcode || '%'
        where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date <= ${last}::date and accounting.can_view_account(l.account_id)
        order by l.id, length(mp.mcode) desc
      )
      select * from raw`;
    for (const line of lines) {
      if (!line.party_id) {
        errors.push(`Línea sin tercero: comprobante ${line.entry ?? "(borrador)"} línea ${line.line_no} en la cuenta ${line.code}`);
        continue;
      }
      bump(cell(line.concept, line.party_id).values, columnIds[0]!, Number(line.balance));
    }
    // Only balances in the account's own direction are reported.
    for (const [key, entry] of cells) if ((entry.values[columnIds[0]!] ?? 0) <= 0) cells.delete(key);
  } else if (mappings.length > 0) {
    const lines = await ctx.tx<{ concept: string; party_id: string | null; entry: string | null; line_no: number; code: string; debit: string; credit: string; tax_base: string | null; contra: boolean }[]>`
      with mapped as (select * from unnest(${concepts}::text[], ${codes}::text[]) as t(concept, mcode)),
      raw as (
        select distinct on (l.id) mp.concept, l.party_id, l.entry_id, e.number as entry, l.line_no, a.code, l.debit, l.credit, l.tax_base,
               (e.reversal_of_id is not null or e.source_entity = 'invoicing.note') as contra
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
        join mapped mp on a.code like mp.mcode || '%'
        where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date between ${first}::date and ${last}::date
          and not e.is_opening and not e.is_closing and accounting.can_view_account(l.account_id)
        order by l.id, length(mp.mcode) desc
      ),
      fallback as (
        select l.entry_id, (array_agg(distinct l.party_id))[1] as party from accounting.entry_lines l
        where l.entry_id in (select entry_id from raw) and l.party_id is not null group by l.entry_id having count(distinct l.party_id) = 1
      )
      select r.concept, coalesce(r.party_id, f.party) as party_id, r.entry, r.line_no, r.code, r.debit, r.credit, r.tax_base, r.contra
      from raw r left join fallback f on f.entry_id = r.entry_id`;
    const sums = new Map<string, { amount: number; base: number; hasBase: boolean }>();
    for (const line of lines) {
      const own = Number(format.side === "debit" ? line.debit : line.credit);
      const opposite = Number(format.side === "debit" ? line.credit : line.debit);
      const amount = own - (line.contra ? opposite : 0);
      // A line on the other side that is not a reversal or a credit note adds nothing: it needs no party either.
      if (amount === 0 && !(line.tax_base !== null && own > 0)) continue;
      if (!line.party_id) {
        errors.push(`Línea sin tercero: comprobante ${line.entry ?? "(borrador)"} línea ${line.line_no} en la cuenta ${line.code}`);
        continue;
      }
      const key = `${line.concept}|${line.party_id}`;
      const sum = sums.get(key) ?? { amount: 0, base: 0, hasBase: false };
      sum.amount += amount;
      if (line.tax_base !== null && own > 0) {
        sum.base += Number(line.tax_base);
        sum.hasBase = true;
      }
      sums.set(key, sum);
    }
    for (const [key, sum] of sums) {
      const [concept, partyId] = key.split("|") as [string, string];
      const target = cell(concept, partyId);
      for (const column of format.columns) {
        if (column.source === "amount") bump(target.values, column.id, sum.amount);
        else if (column.source === "base") bump(target.values, column.id, sum.hasBase ? sum.base : sum.amount);
      }
    }
    // Withholdings practised or suffered (tax:FAMILY columns): from the tax lines, on the party's principal concept.
    const taxColumns = format.columns.filter((c) => c.source.startsWith("tax:"));
    if (taxColumns.length > 0) {
      const tax = await ctx.tx<{ party_id: string; family: string; amount: string }[]>`
        select party_id, split_part(tax_code, '_', 1) as family, sum(credit - debit) as amount
        from accounting.v_tax_lines where date between ${first}::date and ${last}::date and party_id is not null group by party_id, split_part(tax_code, '_', 1)`;
      for (const t of tax) {
        const principal = [...cells.values()].filter((c) => c.partyId === t.party_id).sort((a, b) => b.values[columnIds[0]!]! - a.values[columnIds[0]!]! || a.concept.localeCompare(b.concept))[0];
        if (!principal) continue;
        for (const column of taxColumns) if (column.source === `tax:${t.family}`) bump(principal.values, column.id, Math.abs(Number(t.amount)));
      }
    }

    // Accounts with movement the mapping does not cover, when the format maps result accounts (§5.11, errors).
    const balanceSheet = pack.statementLayouts().balanceSheet.map((s) => s.code);
    // The statement sections of the mapped result accounts: an account of one of them the mapping leaves out is a gap (cost of sales,
    // for one, is not covered by 1001 and is not asked for).
    const covered = await ctx.tx<{ section: string }[]>`
      select distinct a.statement_section as section from accounting.fiscal_concept_mappings m join accounting.accounts a on a.id = m.account_id
      where m.company_id = ${ctx.companyId} and m.format = ${formatId} and m.is_active and a.statement_section is not null and a.statement_section <> all(${balanceSheet}::text[])`;
    if (covered.length > 0) {
      const sections = covered.map((c) => c.section);
      const unmapped = await ctx.tx<{ code: string; name: string; movement: string }[]>`
        select a.code, a.name, sum(case ${format.side} when 'debit' then l.debit else l.credit end) as movement
        from accounting.entry_lines l join accounting.entries e on e.id = l.entry_id join accounting.accounts a on a.id = l.account_id
        where l.company_id = ${ctx.companyId} and e.status in ('posted', 'reversed') and e.date between ${first}::date and ${last}::date
          and not e.is_opening and not e.is_closing and accounting.can_view_account(a.id)
          and a.statement_section = any(${sections}::text[])
          and not exists (select 1 from accounting.fiscal_concept_mappings c join accounting.accounts mapped on mapped.id = c.account_id
                          where c.company_id = ${ctx.companyId} and c.format = ${formatId} and c.is_active and a.code like mapped.code || '%')
        group by a.code, a.name having sum(case ${format.side} when 'debit' then l.debit else l.credit end) > 0 order by a.code`;
      for (const u of unmapped) errors.push(`Cuenta sin concepto en el formato ${formatId}: ${u.code} · ${u.name} (movimiento $ ${cents(Number(u.movement))})`);
    }
  }

  // Parties: data the file needs.
  const partyIds = [...new Set([...cells.values()].map((c) => c.partyId))];
  const parties = new Map(
    (partyIds.length === 0
      ? []
      : await ctx.tx<PartyInfo[]>`
          select id, document_type, document_number, check_digit, legal_name, department_code, municipality_code, country_code from core.v_parties where id = any(${partyIds}::uuid[])`
    ).map((p) => [p.id, p]),
  );

  const label = new Map(format.concepts.map((c) => [c.code, c.label]));
  const small = new Map<string, Record<string, number>>();
  const rows: Record<string, unknown>[] = [];
  const exogenaRows: ExogenaRow[] = [];
  const emit = (concept: string, party: { id: string | null; type: string; document: string; dv?: string | null; name: string; dpto?: string | null; mun?: string | null; country: string }, values: Record<string, number>) => {
    const row: Record<string, unknown> = {
      concept, concept_label: label.get(concept) ?? "", party_id: party.id, party_document_type: party.type, party_document: party.document, party_dv: party.dv ?? "", party_name: party.name,
    };
    columnIds.forEach((id, i) => {
      row[id] = cents(values[id] ?? 0);
      if (i < MAX_COLUMNS) row[`col${i + 1}`] = cents(values[id] ?? 0);
    });
    rows.push(row);
    exogenaRows.push({
      concept, partyDocumentType: party.type, partyDocument: party.document, ...(party.dv ? { partyDv: party.dv } : {}), partyName: party.name,
      ...(party.dpto ? { departmentCode: party.dpto } : {}), ...(party.mun ? { municipalityCode: party.mun } : {}), countryCode: party.country, values,
    });
  };
  const flagged = new Set<string>();
  for (const entry of [...cells.values()].sort((a, b) => a.concept.localeCompare(b.concept) || a.partyId.localeCompare(b.partyId))) {
    if (Object.values(entry.values).every((v) => Math.abs(v) < 0.005)) continue;
    const mainValue = entry.values[columnIds[0]!]!;
    if (threshold > 0 && mainValue < threshold) {
      const acc = small.get(entry.concept) ?? Object.fromEntries(columnIds.map((id) => [id, 0]));
      for (const id of columnIds) bump(acc, id, entry.values[id] ?? 0);
      small.set(entry.concept, acc);
      continue;
    }
    const party = parties.get(entry.partyId);
    if (!party || !party.document_number) {
      errors.push(`El tercero ${entry.partyId} no existe o no es visible`);
      continue;
    }
    const name = party.legal_name ?? party.document_number;
    if (!party.document_type && !flagged.has(`${party.id}:doc`)) {
      flagged.add(`${party.id}:doc`);
      errors.push(`El tercero ${party.document_number} · ${name} no tiene tipo de documento`);
    }
    const national = !party.country_code || party.country_code === "CO";
    if (national && (!party.department_code || !party.municipality_code) && !flagged.has(`${party.id}:dane`)) {
      flagged.add(`${party.id}:dane`);
      errors.push(`El tercero ${party.document_number} · ${name} no tiene código DANE de departamento y municipio`);
    }
    emit(entry.concept, {
      id: party.id, type: party.document_type ?? "", document: party.document_number, dv: party.check_digit, name,
      dpto: party.department_code, mun: party.municipality_code, country: party.country_code ?? "CO",
    }, entry.values);
  }
  for (const [concept, values] of [...small].sort((a, b) => a[0].localeCompare(b[0]))) {
    emit(concept, { id: null, type: UNIDENTIFIED_TYPE, document: format.cuantiasMenoresNit, name: CUANTIAS_NAME, country: "CO" }, values);
  }
  return { format, rows, exogenaRows, errors: [...new Set(errors)] };
}

export const exogenaConsult = defineProcess({
  id: "accounting.report.exogena",
  module: "accounting",
  kind: "consult",
  feature: "accounting.ledger",
  description: "Información exógena de un formato y año gravable: valores por tercero y concepto según el mapeo de conceptos, con la lista de errores que impiden el archivo",
  input: reportInput(params),
  output: reportOutput,
  handler: async (ctx, { params: p, state }) => {
    const data = await exogenaData(ctx, p.year, p.format, p.threshold);
    return windowOf(data.rows, state, {
      totals: Array.from({ length: Math.min(data.format.columns.length, MAX_COLUMNS) }, (_, i) => `col${i + 1}`),
      extra: {
        errors: data.errors, columns: data.format.columns.map((c, i) => ({ field: `col${i + 1}`, id: c.id, label: c.label })), version: data.format.version,
        threshold: p.threshold ?? data.format.threshold, side: data.format.side,
      },
    });
  },
});

export const exogenaReport = defineReport({
  id: "accounting.exogena",
  module: "accounting",
  feature: "accounting.ledger",
  label: "report.accounting.exogena",
  params,
  consult: "accounting.report.exogena",
  columns,
  totals: ["col1", "col2", "col3"],
  pdfTitle: "Información exógena",
});
