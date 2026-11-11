import { defineProcess, defineReport, ProcessError, type ExogenaFormat, type ExogenaRow, type ProcessContext, type ReportColumn } from "@erp/kernel";
import { z } from "zod";
import { companyPack } from "../processes/common";
import { cents, reportInput, reportOutput, RESTRICTED_CODE, RESTRICTED_PARTIES, windowOf } from "./common";

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
  ...Array.from({ length: MAX_COLUMNS }, (_, i) => ({ field: `col${i + 1}`, label: `report.col.value_${i + 1}`, type: "money" as const, currency: "company" as const, total: "sum" as const, mono: true })),
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

  // The figures come from the security-definer aggregates of 0046 (D11, Task 9 review I1): a comprobante, an account or a party a
  // record rule hides from the caller still counts; a line with no party in a hidden comprobante is counted, never named.
  const [{ n: mapped } = { n: 0 }] = await ctx.tx<{ n: number }[]>`
    select count(*)::int as n from accounting.fiscal_concept_mappings where company_id = ${ctx.companyId} and format = ${formatId} and is_active`;
  const missingParty = (line: { entry: string | null; line_no: number | null; code: string | null }) =>
    errors.push(`Línea sin tercero: comprobante ${line.entry ?? "(borrador)"} línea ${line.line_no} en la cuenta ${line.code}`);
  const hiddenMissing = (count: number) => {
    if (count > 0) errors.push(`${count} ${count === 1 ? "línea sin tercero en un comprobante restringido" : "líneas sin tercero en comprobantes restringidos"} para tu usuario`);
  };
  type Cell = { concept: string | null; party_id: string | null; amount: string | null; base: string | null; has_base: boolean; entry: string | null; line_no: number | null; code: string | null; hidden_lines: number };

  if (mapped > 0 && format.side === "balance") {
    const lines = await ctx.tx<Cell[]>`select * from accounting.exogena_cells(${formatId}, ${first}::date, ${last}::date, 'balance')`;
    for (const line of lines) {
      if (line.hidden_lines > 0) hiddenMissing(line.hidden_lines);
      else if (!line.party_id) missingParty(line);
      else bump(cell(line.concept!, line.party_id).values, columnIds[0]!, Number(line.amount));
    }
    // Only balances in the account's own direction are reported.
    for (const [key, entry] of cells) if ((entry.values[columnIds[0]!] ?? 0) <= 0) cells.delete(key);
  } else if (mapped > 0) {
    const lines = await ctx.tx<Cell[]>`select * from accounting.exogena_cells(${formatId}, ${first}::date, ${last}::date, ${format.side})`;
    for (const line of lines) {
      if (line.hidden_lines > 0) {
        hiddenMissing(line.hidden_lines);
        continue;
      }
      if (!line.party_id) {
        missingParty(line);
        continue;
      }
      const target = cell(line.concept!, line.party_id);
      const amount = Number(line.amount);
      for (const column of format.columns) {
        if (column.source === "amount") bump(target.values, column.id, amount);
        else if (column.source === "base") bump(target.values, column.id, line.has_base ? Number(line.base) : amount);
      }
    }
    // Withholdings practised or suffered (tax:FAMILY columns): from the tax lines, on the party's principal concept.
    const taxColumns = format.columns.filter((c) => c.source.startsWith("tax:"));
    if (taxColumns.length > 0) {
      const tax = await ctx.tx<{ party_id: string; family: string; amount: string }[]>`
        select party_id, family, amount from accounting.exogena_tax_sums(${first}::date, ${last}::date)`;
      for (const t of tax) {
        const principal = [...cells.values()].filter((c) => c.partyId === t.party_id).sort((a, b) => b.values[columnIds[0]!]! - a.values[columnIds[0]!]! || a.concept.localeCompare(b.concept))[0];
        if (!principal) continue;
        for (const column of taxColumns) if (column.source === `tax:${t.family}`) bump(principal.values, column.id, Math.abs(Number(t.amount)));
      }
    }

    // Accounts with movement the mapping does not cover, when the format maps result accounts (§5.11, errors): an account of a
    // section of the mapped result accounts the mapping leaves out is a gap (cost of sales, for one, is not covered by 1001).
    const balanceSheet = pack.statementLayouts().balanceSheet.map((s) => s.code);
    const unmapped = await ctx.tx<{ code: string | null; name: string | null; restricted: boolean; movement: string }[]>`
      select code, name, restricted, movement from accounting.exogena_unmapped(${formatId}, ${first}::date, ${last}::date, ${format.side}, ${balanceSheet}::text[])`;
    const hiddenUnmapped = unmapped.filter((u) => u.restricted).length;
    for (const u of unmapped.filter((x) => !x.restricted)) errors.push(`Cuenta sin concepto en el formato ${formatId}: ${u.code} · ${u.name} (movimiento $ ${cents(Number(u.movement))})`);
    if (hiddenUnmapped > 0) errors.push(`${hiddenUnmapped} ${hiddenUnmapped === 1 ? "cuenta restringida" : "cuentas restringidas"} para tu usuario sin concepto en el formato ${formatId}`);
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
  const hiddenParties = new Map<string, { count: number; values: Record<string, number> }>();
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
      // A party the caller may not read (a record rule or the party scope): its figures stay, under the lock line of its concept.
      const acc = hiddenParties.get(entry.concept) ?? { count: 0, values: Object.fromEntries(columnIds.map((id) => [id, 0])) };
      for (const id of columnIds) bump(acc.values, id, entry.values[id] ?? 0);
      acc.count += 1;
      hiddenParties.set(entry.concept, acc);
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
  const hiddenCount = [...hiddenParties.values()].reduce((sum, h) => sum + h.count, 0);
  for (const [concept, { values }] of [...hiddenParties].sort((a, b) => a[0].localeCompare(b[0]))) {
    emit(concept, { id: null, type: "", document: RESTRICTED_CODE, name: RESTRICTED_PARTIES, country: "CO" }, values);
  }
  if (hiddenCount > 0) {
    errors.push(`${hiddenCount === 1 ? "Un tercero no es visible" : `${hiddenCount} terceros no son visibles`} para tu usuario (restringidos): el archivo lo genera quien pueda verlos`);
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
  fileActions: [{ id: "xml", label: "report.file.exogena_xml", process: "accounting.report.exogena_xml", contentType: "application/xml", contentField: "xml" }],
  pdfTitle: "Información exógena",
});
